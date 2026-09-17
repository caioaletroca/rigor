/**
 * Cycle lifecycle MCP tools: cycle_init and cycle_status.
 *
 * Exported handler functions are pure logic that accept dependencies
 * and return the MCP CallToolResult shape. This keeps them testable
 * without spinning up a real MCP transport.
 */

import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StateManager } from "../state/index.js";
import type { PhaseState, EpicState, TaskState } from "../state/index.js";
import type { RigorConfig } from "../config/index.js";
import { evaluateResolvedProjectReadiness } from "../services/project-readiness.js";
import { parsePlan } from "../plan/index.js";
import { EvidenceManager } from "../evidence/index.js";
import { isGate0AttemptActive, isTaskCompletionActive } from "../services/task-lifecycle.js";
import { ProjectContextRegistry, resolveProjectRoot as resolveCanonicalProjectRoot } from "../context.js";
import type { ParsedPhase, ParsedEpic, ParsedTask } from "../plan/index.js";
import { responseResult } from "./response.js";
import { projectRootSchema } from "./lifecycle.js";
import { withProjectMutationLock } from "../lifecycle/index.js";

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function textResult(text: string, isError?: boolean): CallToolResult {
  return responseResult(text, { error: isError });
}

// ---------------------------------------------------------------------------
// Project-root resolution
// ---------------------------------------------------------------------------

/**
 * Walk upward from `startDir` looking for a `.git` marker (directory or file),
 * returning the first directory that contains one. Returns `null` when no
 * repository root is found before reaching the filesystem root.
 */
/**
 * Resolve the project root to anchor `.rigor/` state against.
 *
 * When `planPath` is absolute, its enclosing git repository root is the most
 * reliable signal — the server's `--project-root` may have been misconfigured
 * or omitted (a known dogfood recurrence). Falls back to `serverRoot` for
 * relative plan paths or when the plan is not inside a git repository, keeping
 * the explicit server root authoritative whenever it is the only signal.
 */
function resolveProjectRoot(planPath: string, serverRoot: string): string {
  return resolveCanonicalProjectRoot({
    plan_path: planPath,
    fallback_root: serverRoot,
  }).project_root;
}

// ---------------------------------------------------------------------------
// Conversion: ParsedPlan types -> State types
// ---------------------------------------------------------------------------

function taskToState(parsed: ParsedTask): TaskState {
  return {
    id: parsed.id,
    name: parsed.name,
    status: parsed.done ? "done" : "pending",
    gate_0: { passed: false },
  };
}

function epicToState(parsed: ParsedEpic): EpicState {
  return {
    id: parsed.id,
    name: parsed.name,
    status: "pending",
    tasks: parsed.tasks.map(taskToState),
    gate_8: { passed: false },
    gate_9: { passed: false },
  };
}

function phaseToState(parsed: ParsedPhase): PhaseState {
  return {
    id: parsed.id,
    status: "pending",
    epics: parsed.epics.map(epicToState),
  };
}

// ---------------------------------------------------------------------------
// cycle_init handler
// ---------------------------------------------------------------------------

export interface CycleInitParams {
  plan_path: string;
  project_root?: string;
  allow_shared_workspace?: boolean;
}

const WORKTREE_REMEDIATION =
  "Run rigor:worktree to create an isolated worktree and feature branch, then re-run cycle_init from it.";
const ROOT_REMEDIATION = "Pass the active worktree's absolute project_root.";

export function handleCycleInit(
  params: CycleInitParams,
  stateManager: StateManager,
  projectRoot: string,
  configOrRegistry?: RigorConfig | ProjectContextRegistry,
  registry?: ProjectContextRegistry,
): Promise<CallToolResult> {
  const requestRoot = params.project_root ?? projectRoot;
  const resolvedPath = isAbsolute(params.plan_path) ? params.plan_path : resolve(requestRoot, params.plan_path);
  const effectiveRoot = resolveProjectRoot(resolvedPath, requestRoot);
  return withProjectMutationLock(effectiveRoot, async () => handleCycleInitUnlocked(params, stateManager, projectRoot, configOrRegistry, registry));
}

function handleCycleInitUnlocked(
  params: CycleInitParams,
  stateManager: StateManager,
  projectRoot: string,
  configOrRegistry?: RigorConfig | ProjectContextRegistry,
  registry?: ProjectContextRegistry,
): CallToolResult {
  const config = configOrRegistry instanceof ProjectContextRegistry ? undefined : configOrRegistry;
  const contextRegistry = configOrRegistry instanceof ProjectContextRegistry ? configOrRegistry : registry;
  const requestRoot = params.project_root ?? projectRoot;
  const resolvedPath = isAbsolute(params.plan_path)
    ? params.plan_path
    : resolve(requestRoot, params.plan_path);

  // Prefer the plan's git root when an absolute plan path points outside the
  // server's configured root. State/evidence then land under the correct
  // repository even if `--project-root` was wrong. When they agree (or no repo
  // is found), the server-provided StateManager is used unchanged.
  const rootResolution = resolveCanonicalProjectRoot({
    project_root: params.project_root,
    plan_path: resolvedPath,
    fallback_root: projectRoot,
  });
  const effectiveRoot = rootResolution.project_root;
  const usingDerivedRoot = effectiveRoot !== projectRoot;
  const context = contextRegistry?.getByRoot(effectiveRoot);
  const sm = context?.stateManager ?? (usingDerivedRoot ? new StateManager(effectiveRoot) : stateManager);
  const effectiveConfig = context?.config ?? config;

  const readiness = evaluateResolvedProjectReadiness(rootResolution, effectiveConfig);
  if (!readiness.gate_0.ready) {
    const provenance = readiness.gate_0.provenance;
    const source = provenance.path ? `${provenance.category} (${provenance.path})` : provenance.category;
    return textResult(
      `Cycle initialization blocked: ${readiness.gate_0.detail} Gate 0 check source: ${source}. ${ROOT_REMEDIATION}`,
      true,
    );
  }

  if (params.allow_shared_workspace) {
    if (!readiness.config.workspace.allow_override) {
      return textResult(
        "allow_shared_workspace is disabled by project config (workspace.allow_override is false).",
        true,
      );
    }
  } else if (readiness.config.workspace.require_worktree || readiness.config.workspace.require_feature_branch) {
    if (readiness.workspace_policy.inspection_failure) {
      return textResult(readiness.workspace_policy.inspection_failure, true);
    }
    if (readiness.workspace?.detached) {
      return textResult(
        `A cycle cannot be anchored to a detached HEAD. ${WORKTREE_REMEDIATION}`,
        true,
      );
    }
    if (
      readiness.workspace?.branch !== null &&
      readiness.workspace?.branch !== undefined &&
      readiness.config.workspace.require_feature_branch &&
      readiness.config.workspace.base_branches.includes(readiness.workspace.branch)
    ) {
      return textResult(
        `Branch '${readiness.workspace.branch}' is an integration branch, not an agent workspace. ${WORKTREE_REMEDIATION}`,
        true,
      );
    }
    if (readiness.config.workspace.require_worktree && !readiness.workspace?.is_linked_worktree) {
      return textResult(
        `A cycle must run in a dedicated worktree, not the main checkout. ${WORKTREE_REMEDIATION}`,
        true,
      );
    }
  }

  const existing = sm.load();
  if (existing !== null) {
    const existingPlanPath = resolve(effectiveRoot, existing.plan_path);
    if (existingPlanPath !== resolvedPath) {
      return textResult(
        `This worktree already belongs to cycle "${existing.cycle_id}" using plan "${existing.plan_path}". Initialize the other plan in a separate worktree. ${WORKTREE_REMEDIATION}`,
        true,
      );
    }

    return textResult(
      "A cycle already exists. Use cycle_reset to start over.",
      true,
    );
  }

  const plan = parsePlan(resolvedPath);

  const phases = plan.phases.map(phaseToState);

  const state = sm.init(resolvedPath, phases, effectiveRoot);

  let epicCount = 0;
  let taskCount = 0;
  for (const phase of state.phases) {
    epicCount += phase.epics.length;
    for (const epic of phase.epics) {
      taskCount += epic.tasks.length;
    }
  }

  const summary: Record<string, unknown> = {
    project_root: effectiveRoot,
    cycle_id: state.cycle_id,
    plan_path: state.plan_path,
    phases: state.phases.length,
    epics: epicCount,
    tasks: taskCount,
  };

  if (usingDerivedRoot) {
    summary.project_root = effectiveRoot;
    summary.warning =
      `Server --project-root (${projectRoot}) differs from the plan's git root ` +
      `(${effectiveRoot}). State and evidence were written under the git root.`;
  }

  return textResult(JSON.stringify(summary, null, 2));
}

// ---------------------------------------------------------------------------
// cycle_reload handler
// ---------------------------------------------------------------------------

export interface CycleReloadParams {
  plan_path?: string;
  project_root?: string;
}

/**
 * Re-parse the plan and merge NEW phases/epics/tasks into the existing cycle
 * without destroying progress. Enables rolling-wave execution: later phases
 * that were epic-level (no tasks) at cycle_init can be elaborated in the plan
 * and ingested mid-cycle. Existing entities keep their status and gate
 * evidence untouched; entities removed from the plan are left in place.
 */
export function handleCycleReload(
  params: CycleReloadParams,
  stateManager: StateManager,
  projectRoot: string,
  registry?: ProjectContextRegistry,
): Promise<CallToolResult> {
  const loadedRoot = stateManager.load()?.project_root;
  const requestRoot = params.project_root ?? loadedRoot ?? projectRoot;
  const effectiveRoot = params.project_root
    ? resolveCanonicalProjectRoot({ project_root: params.project_root, fallback_root: requestRoot }).project_root
    : loadedRoot ?? projectRoot;
  return withProjectMutationLock(effectiveRoot, async () => handleCycleReloadUnlocked(params, stateManager, projectRoot, registry));
}

function handleCycleReloadUnlocked(
  params: CycleReloadParams,
  stateManager: StateManager,
  projectRoot: string,
  registry?: ProjectContextRegistry,
): CallToolResult {
  // Mirror cycle_init: when an absolute plan_path override points outside the
  // server root, target that plan's git root. Without an override (or with a
  // relative one), the server root stays authoritative and behavior is
  // unchanged.
  const loadedState = stateManager.load();
  const loadedRoot = loadedState?.project_root;
  const requestRoot = params.project_root ?? loadedRoot ?? projectRoot;
  const planPath = params.plan_path
    ? isAbsolute(params.plan_path) ? params.plan_path : resolve(requestRoot, params.plan_path)
    : loadedState?.plan_path;
  if (!planPath) return textResult("No active cycle. Run cycle_init first.", true);
  const effectiveRoot = params.project_root
    ? resolveCanonicalProjectRoot({
        project_root: params.project_root,
        plan_path: planPath,
        fallback_root: requestRoot,
      }).project_root
    : loadedRoot ?? projectRoot;
  if (loadedRoot && effectiveRoot !== loadedRoot) {
    return textResult(`Invalid reload project_root: active cycle belongs to "${loadedRoot}"; use that root.`, true);
  }
  const usingDerivedRoot = effectiveRoot !== projectRoot;
  const context = registry?.getByRoot(effectiveRoot);
  const sm = context?.stateManager ?? (usingDerivedRoot ? new StateManager(effectiveRoot) : stateManager);

  const state = sm.load();
  if (state === null) {
    return textResult("No active cycle. Run cycle_init first.", true);
  }

  let plan;
  try {
    plan = parsePlan(planPath);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return textResult(`Failed to parse plan at ${planPath}: ${msg}`, true);
  }

  const added = { phases: 0, epics: 0, tasks: 0 };

  for (const parsedPhase of plan.phases) {
    const phase = state.phases.find((p) => p.id === parsedPhase.id);
    if (!phase) {
      const newPhase = phaseToState(parsedPhase);
      state.phases.push(newPhase);
      added.phases++;
      added.epics += newPhase.epics.length;
      for (const e of newPhase.epics) added.tasks += e.tasks.length;
      continue;
    }

    for (const parsedEpic of parsedPhase.epics) {
      const epic = phase.epics.find((e) => e.id === parsedEpic.id);
      if (!epic) {
        const newEpic = epicToState(parsedEpic);
        phase.epics.push(newEpic);
        added.epics++;
        added.tasks += newEpic.tasks.length;
        continue;
      }

      for (const parsedTask of parsedEpic.tasks) {
        const exists = epic.tasks.some((t) => t.id === parsedTask.id);
        if (!exists) {
          epic.tasks.push(taskToState(parsedTask));
          added.tasks++;
        }
        // Existing task: keep its status and gate_0 evidence untouched.
      }
    }
  }

  if (params.plan_path) {
    state.plan_path = planPath;
  }
  state.project_root = effectiveRoot;

  sm.save(state);

  const summary: Record<string, unknown> = {
    reloaded_from: planPath,
    added,
    note: "Existing phases, epics, and tasks kept their status and evidence; only new entities were added.",
  };

  if (usingDerivedRoot) {
    summary.project_root = effectiveRoot;
    summary.warning =
      `Server --project-root (${projectRoot}) differs from the plan's git root ` +
      `(${effectiveRoot}). State was read and written under the git root.`;
  }

  return textResult(JSON.stringify(summary, null, 2));
}

// ---------------------------------------------------------------------------
// cycle_status handler
// ---------------------------------------------------------------------------

export function handleCycleStatus(
  stateManager: StateManager,
  evidenceManager?: EvidenceManager,
  projectRoot?: string,
): CallToolResult {
  const state = stateManager.load();
  if (state === null) {
    return textResult(
      "No active cycle. Run cycle_init with a plan path first.",
    );
  }

  const currentPhase = state.phases.find(
    (p) => p.id === state.current_phase,
  );

  let activeTask: { id: string; name: string; epicId: string } | null = null;
  let liveTask: { id: string; name: string; epicId: string } | null = null;
  for (const phase of state.phases) {
    for (const epic of phase.epics) {
      for (const task of epic.tasks) {
        if (task.status !== "doing") continue;
        const candidate = { id: task.id, name: task.name, epicId: epic.id };
        activeTask ??= candidate;
        const attempt = evidenceManager?.load("gate_0", task.id)?.gate_0_attempt;
        if (
          projectRoot &&
          attempt &&
          !attempt.finished_at &&
          attempt.current_check &&
          isGate0AttemptActive(projectRoot, task.id, attempt.id)
        ) {
          liveTask = candidate;
        }
      }
    }
  }
  activeTask = liveTask ?? activeTask;

  // Progress for the current phase
  let tasksCompleted = 0;
  let tasksTotal = 0;
  if (currentPhase) {
    for (const epic of currentPhase.epics) {
      for (const task of epic.tasks) {
        tasksTotal++;
        if (task.status === "done") {
          tasksCompleted++;
        }
      }
    }
  }

  const lines: string[] = [];

  lines.push(`Cycle: ${state.cycle_id}`);
  lines.push(`Project Root: ${state.project_root ?? projectRoot ?? "unknown"}`);
  lines.push(`Plan: ${state.plan_path}`);
  lines.push("");

  if (currentPhase) {
    lines.push(`Current Phase: ${currentPhase.id} (${currentPhase.status})`);
  } else {
    lines.push(`Current Phase: ${state.current_phase} (not found)`);
  }

  lines.push("");
  lines.push("Epics:");

  for (const phase of state.phases) {
    for (const epic of phase.epics) {
      const g8 = epic.gate_8.passed ? "pass" : "fail";
      const g9 = epic.gate_9.passed ? "pass" : "fail";
      lines.push(
        `  ${epic.id} ${epic.name} [${epic.status}] gate_8:${g8} gate_9:${g9}`,
      );
    }
  }

  lines.push("");

  if (activeTask) {
    lines.push(`Active Task: ${activeTask.id} ${activeTask.name} (epic ${activeTask.epicId})`);
    const attempt = evidenceManager?.load("gate_0", activeTask.id)?.gate_0_attempt;
    if (attempt && !attempt.finished_at && attempt.current_check) {
      if (projectRoot && isGate0AttemptActive(projectRoot, activeTask.id, attempt.id)) {
        const elapsedMs = Date.now() - Date.parse(attempt.current_check.started_at);
        const timeout = attempt.current_check.configured_timeout_ms === undefined
          ? "not configured"
          : `${attempt.current_check.configured_timeout_ms}ms`;
        lines.push(`Gate 0: executing ${attempt.current_check.check_name} (${elapsedMs}ms elapsed, timeout: ${timeout})`);
        lines.push(`Evidence: ${stateManager.getTask(activeTask.id).gate_0.evidence_path ?? "gate_0-task-" + activeTask.id + ".json"}`);
      } else {
        lines.push("Gate 0: stale unfinished attempt; task remains stuck.");
      }
    } else if (projectRoot && isTaskCompletionActive(projectRoot, activeTask.id)) {
      lines.push("Gate 0: post_task custom gates executing.");
    }
  } else {
    lines.push("Active Task: none");
  }

  lines.push("");
  lines.push(`Progress (phase ${state.current_phase}): ${tasksCompleted}/${tasksTotal} tasks completed`);

  return textResult(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCycleTools(
  server: McpServer,
  stateManager: StateManager,
  _config: RigorConfig,
  projectRoot: string,
  registry?: ProjectContextRegistry,
): void {
  server.tool(
    "cycle_init",
    "Initialize a new development cycle from a plan.md file",
    {
      plan_path: z.string().describe("Absolute plan path, or relative to project_root or the legacy server --project-root fallback"),
      project_root: projectRootSchema.describe("Absolute Git repository root; takes precedence over the server --project-root fallback"),
      allow_shared_workspace: z.boolean().optional(),
    },
    async (params) => {
      const root = params.project_root ?? projectRoot;
      const context = registry?.getByRoot(root);
      return handleCycleInit(
        params,
        context?.stateManager ?? stateManager,
        root,
        context?.config ?? _config,
        registry,
      );
    },
  );

  server.tool(
    "cycle_reload",
    "Re-parse the plan and merge new phases/epics/tasks into the running cycle without losing progress (rolling-wave elaboration)",
    {
       plan_path: z
         .string()
         .optional()
         .describe("Absolute plan path, or relative to project_root; defaults to the stored plan_path"),
       project_root: projectRootSchema.describe("Absolute Git repository root; overrides the server default and anchors relative plan_path"),
    },
    async (params) => {
      const root = params.project_root ?? projectRoot;
      const context = registry?.getByRoot(root);
      return handleCycleReload(params, context?.stateManager ?? stateManager, root, registry);
    },
  );

  server.tool(
    "cycle_status",
    "Show the current cycle status, progress, and active task",
    { project_root: projectRootSchema },
    async (params) => {
      const root = params?.project_root ?? stateManager.load()?.project_root ?? projectRoot;
      const context = registry?.getByRoot(root);
      return handleCycleStatus(
        context?.stateManager ?? stateManager,
        context?.evidenceManager ?? new EvidenceManager(root),
        context?.project_root ?? root,
      );
    },
  );
}
