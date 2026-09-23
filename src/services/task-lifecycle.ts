/**
 * Gate 0 MCP tools: task_start and task_complete.
 *
 * task_start  — validates entry criteria, transitions a task to "doing".
 * task_complete — runs Gate 0 exit checks, saves evidence, transitions
 *                 the task to "done" or "failed".
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { responseResult } from "../tools/lifecycle.js";
import type { StateManager, TaskWorker } from "../state/index.js";
import { EntityNotFoundError, isValidTransition } from "../state/index.js";
import type { RigorConfig } from "../config/index.js";
import { loadConfig } from "../config/index.js";
import { EvidenceManager } from "../evidence/index.js";
import type { GateEvidence } from "../evidence/index.js";
import {
  checkGate0Exit,
  checkGate1Exit,
  evaluateGate0Readiness,
  runCustomGates,
} from "../gates/index.js";
import { evaluateResolvedProjectReadiness, gate0ReadinessBlockMessage, workspacePolicyBlockMessage } from "./project-readiness.js";
import { runCommand } from "../executor/index.js";
import { withProjectMutationLock } from "../lifecycle/index.js";

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function textResult(text: string, isError?: boolean): CallToolResult {
  return responseResult(text, { error: isError });
}

const activeTaskCompletions = new Map<string, string>();

function completionKey(projectRoot: string, taskId: string): string {
  return `${projectRoot}\u0000${taskId}`;
}

export function isGate0AttemptActive(projectRoot: string, taskId: string, attemptId: string): boolean {
  return activeTaskCompletions.get(completionKey(projectRoot, taskId)) === attemptId;
}

export function isTaskCompletionActive(projectRoot: string, taskId: string): boolean {
  return activeTaskCompletions.has(completionKey(projectRoot, taskId));
}

function activeCompletionResult(taskId: string, attemptId: string): CallToolResult {
  return textResult(
    `Task ${taskId} Gate 0 attempt ${attemptId} is already executing. ` +
      "No checks were rerun. Poll cycle_status for progress and call task_complete again after the attempt reaches a terminal task status.",
  );
}

function staleAttemptResult(taskId: string): CallToolResult {
  return textResult(
    `Task ${taskId} attempt is stale and its result was not promoted. The attempt history was retained; call task_start to begin a fresh attempt.`,
    true,
  );
}

/**
 * Reload canonical state and confirm the task is still "doing".
 *
 * This replaces lease fencing: a completion result is promoted only while the
 * task it belongs to is still in progress, so a task reset or forced status
 * change mid-Gate-0 cannot be overwritten by a late result.
 */
function loadDoingTask(stateManager: StateManager, taskId: string) {
  const state = stateManager.load();
  if (!state) return null;
  const task = state.phases
    .flatMap((phase) => phase.epics)
    .flatMap((epic) => epic.tasks)
    .find((candidate) => candidate.id === taskId);
  if (!task || task.status !== "doing") return null;
  return { state, task };
}

function clearWorker(stateManager: StateManager, taskId: string): boolean {
  const current = loadDoingTask(stateManager, taskId);
  if (!current) return false;
  delete current.task.worker;
  stateManager.save(current.state);
  return true;
}

function terminalCompletionResult(
  taskId: string,
  taskStatus: "done" | "failed",
  evidence: GateEvidence,
  evidencePath: string,
  customEvidence?: GateEvidence | null,
): CallToolResult {
  const lines = [
    `Task ${taskId} already has a terminal Gate 0 result (${taskStatus}); returning persisted evidence without rerunning checks.`,
    "",
    "Gate 0 checks:",
    ...evidence.checks.map((check) => `  [${check.passed ? "PASS" : "FAIL"}] ${check.name}: ${check.detail}`),
  ];
  if (customEvidence) {
    lines.push(
      "",
      "Custom post-task checks:",
      ...customEvidence.checks.map((check) => `  [${check.passed ? "PASS" : "FAIL"}] ${check.name}: ${check.detail}`),
    );
  }
  lines.push("", `Evidence: ${evidencePath}`);
  return textResult(lines.join("\n"), taskStatus === "failed");
}

// ---------------------------------------------------------------------------
// task_start handler
// ---------------------------------------------------------------------------

export interface TaskStartParams {
  task_id: string;
  owner_id?: string;
  project_root?: string;
}

export async function handleTaskStart(
  params: TaskStartParams,
  stateManager: StateManager,
  config: RigorConfig | null,
  projectRoot: string,
): Promise<CallToolResult> {
  // Reload config fresh from disk when not explicitly supplied, so edits to
  // .rigor/config.yaml take effect without restarting the server.
  const cfg = config ?? loadConfig(projectRoot);
  const readiness = evaluateResolvedProjectReadiness(
    { project_root: projectRoot, source: params.project_root ? "explicit" : "fallback" },
    cfg,
  );
  if (!readiness.gate_0.ready) {
    return textResult(gate0ReadinessBlockMessage(params.task_id, readiness), true);
  }
  if (readiness.config.workspace.require_worktree || readiness.config.workspace.require_feature_branch) {
    const workspacePolicyFailure = workspacePolicyBlockMessage(
      readiness,
      "Run rigor:worktree to create an isolated worktree and feature branch, then re-run task_start from it.",
    );
    if (workspacePolicyFailure) return textResult(workspacePolicyFailure, true);
  }

  // 1. Load state, verify cycle exists
  const state = stateManager.load();
  if (state === null) {
    return textResult(
      "No active cycle. Run cycle_init first.",
      true,
    );
  }

  // 2. Find the task
  let task;
  try {
    task = stateManager.getTask(params.task_id);
  } catch (error: unknown) {
    if (error instanceof EntityNotFoundError) {
      return textResult(`Task "${params.task_id}" not found.`, true);
    }
    throw error;
  }

  const ownerId = params.owner_id?.trim() ? params.owner_id.trim() : undefined;
  const priorWorker = task.worker;
  const resumingDoing = task.status === "doing";
  if (task.status !== "pending" && task.status !== "failed" && !resumingDoing) {
    return textResult(
      `Task "${params.task_id}" is in "${task.status}" status. ` +
        `Only "pending" or "failed" tasks can be started.`,
      true,
    );
  }

  // 4. Check that the previous task in the same epic is done
  for (const phase of state.phases) {
    for (const epic of phase.epics) {
      const idx = epic.tasks.findIndex((t) => t.id === params.task_id);
      if (idx > 0) {
        const prev = epic.tasks[idx - 1];
        if (prev.status !== "done") {
          return textResult(
            `Previous task "${prev.id}" (${prev.name}) is "${prev.status}" — ` +
              `it must be "done" before starting "${params.task_id}".`,
            true,
          );
        }
      }
    }
  }

  // 5. Working tree check (warn, don't block)
  const warnings: string[] = [];
  const gitResult = await runCommand("git status --porcelain", { cwd: projectRoot });
  if (gitResult.exit_code === 0 && gitResult.stdout.trim() !== "") {
    warnings.push(
      "Warning: working tree has uncommitted changes.",
    );
  }

  // 5b. Run pre_task custom gates
  const customResult = await runCustomGates("pre_task", params.task_id, cfg, projectRoot);
  if (!customResult.passed) {
    const lines: string[] = [];
    lines.push(`Task ${params.task_id} blocked by custom pre_task gate.`);
    lines.push("");
    for (const check of customResult.checks) {
      const icon = check.passed ? "PASS" : "FAIL";
      lines.push(`  [${icon}] ${check.name}: ${check.detail}`);
    }
    return textResult(lines.join("\n"), true);
  }

  // 5c. Run Gate 1 infrastructure check (conditional)
  const gate1Result = await checkGate1Exit(cfg, projectRoot);
  if (!gate1Result.skipped) {
    // Save Gate 1 evidence
    const evidenceManager = new EvidenceManager(projectRoot);
    const gate1Evidence: GateEvidence = {
      gate: "gate_1",
      entity_id: params.task_id,
      passed: gate1Result.passed,
      timestamp: new Date().toISOString(),
      checks: gate1Result.checks,
    };
    evidenceManager.save(gate1Evidence);

    if (!gate1Result.passed) {
      const lines: string[] = [];
      lines.push(`Task ${params.task_id} blocked by Gate 1 (infrastructure check).`);
      lines.push("");
      for (const check of gate1Result.checks) {
        const icon = check.passed ? "PASS" : "FAIL";
        lines.push(`  [${icon}] ${check.name}: ${check.detail}`);
      }
      return textResult(lines.join("\n"), true);
    }
  }

  const worker: TaskWorker | undefined = ownerId
    ? { owner_id: ownerId, started_at: new Date().toISOString() }
    : undefined;
  const commitResult = await withProjectMutationLock(projectRoot, async () => {
    const currentState = stateManager.load();
    if (!currentState) return textResult("No active cycle. Run cycle_init first.", true);
    const currentTask = currentState.phases.flatMap((phase) => phase.epics).flatMap((epic) => epic.tasks).find((candidate) => candidate.id === params.task_id);
    if (!currentTask || (currentTask.status !== "pending" && currentTask.status !== "failed" && currentTask.status !== "doing")) {
      return textResult(`Task "${params.task_id}" changed before it could be started.`, true);
    }
    currentTask.status = "doing";
    currentTask.worker = worker;
    stateManager.save(currentState);
    return null;
  });
  if (commitResult) return commitResult;

  const lines = [`Task ${params.task_id} started: ${task.name}`, "Status: doing"];
  if (priorWorker && ownerId && priorWorker.owner_id !== ownerId) {
    lines.push(`Warning: task ${params.task_id} was started by "${priorWorker.owner_id}" at ${priorWorker.started_at} in this workspace. Coordinate file ownership or use separate worktrees.`);
  }
  if (warnings.length > 0) lines.push(...warnings);
  return textResult(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// task_complete handler
// ---------------------------------------------------------------------------

export interface TaskCompleteParams {
  task_id: string;
  project_root?: string;
}

export async function handleTaskComplete(
  params: TaskCompleteParams,
  stateManager: StateManager,
  config: RigorConfig | null,
  projectRoot: string,
): Promise<CallToolResult> {
  const activeAttemptId = activeTaskCompletions.get(completionKey(projectRoot, params.task_id));
  if (activeAttemptId) return Promise.resolve(activeCompletionResult(params.task_id, activeAttemptId));
  return handleTaskCompleteUnlocked(params, stateManager, config, projectRoot);
}

async function handleTaskCompleteUnlocked(
  params: TaskCompleteParams,
  stateManager: StateManager,
  config: RigorConfig | null,
  projectRoot: string,
): Promise<CallToolResult> {
  const cfg = config ?? loadConfig(projectRoot);

  // 1. Load state, verify cycle exists
  const state = stateManager.load();
  if (state === null) {
    return textResult(
      "No active cycle. Run cycle_init first.",
      true,
    );
  }

  // 2. Find the task (must be "doing")
  let task;
  try {
    task = stateManager.getTask(params.task_id);
  } catch (error: unknown) {
    if (error instanceof EntityNotFoundError) {
      return textResult(`Task "${params.task_id}" not found.`, true);
    }
    throw error;
  }

  const evidenceManager = new EvidenceManager(projectRoot);
  const existingEvidence = evidenceManager.load("gate_0", params.task_id);
  const customPostTaskEvidence = evidenceManager.load("custom_post_task", params.task_id);
  const persistedEvidencePath = task.gate_0.evidence_path;
  const hasTerminalGate0Evidence = Boolean(existingEvidence?.gate_0_attempt?.finished_at);
  const hasFailedPostTaskEvidence = customPostTaskEvidence?.passed === false;
  if (
    hasTerminalGate0Evidence &&
    existingEvidence &&
    (
      (task.status === "done" && existingEvidence.passed) ||
      (task.status === "failed" && (!existingEvidence.passed || hasFailedPostTaskEvidence))
    )
  ) {
    return terminalCompletionResult(
      params.task_id,
      task.status,
      existingEvidence,
      persistedEvidencePath ?? "persisted evidence",
      existingEvidence.passed && hasFailedPostTaskEvidence ? customPostTaskEvidence : null,
    );
  }

  const key = completionKey(projectRoot, params.task_id);
  const activeAttemptId = activeTaskCompletions.get(key);
  if (activeAttemptId) {
    return activeCompletionResult(params.task_id, activeAttemptId);
  }

  if (task.status !== "doing") {
    return textResult(
      `Task "${params.task_id}" is in "${task.status}" status. ` +
        `Only "doing" tasks can be completed.`,
      true,
    );
  }

  // 3. Persist an in-progress attempt before running checks so interrupted work is auditable.
  const startedAt = new Date().toISOString();
  const attemptId = crypto.randomUUID();
  activeTaskCompletions.set(key, attemptId);
  try {
    const inProgressEvidence: GateEvidence = {
      gate: "gate_0",
      entity_id: params.task_id,
      passed: false,
      timestamp: startedAt,
      checks: [],
      gate_0_attempt: { version: 1, id: attemptId,
             owner_id: task.worker?.owner_id ?? "legacy",
             started_at: startedAt },
    };
    const inProgressCommit = await withProjectMutationLock(projectRoot, async () => {
      const current = loadDoingTask(stateManager, params.task_id);
      if (!current) return false;
      const inProgressEvidencePath = evidenceManager.save(inProgressEvidence);
      current.task.gate_0 = { ...current.task.gate_0, evidence_path: inProgressEvidencePath };
      stateManager.save(current.state);
      return true;
    });
    if (!inProgressCommit) return staleAttemptResult(params.task_id);

    let gate0Result;
    let executionError: string | undefined;
    try {
      gate0Result = await checkGate0Exit(params.task_id, cfg, projectRoot, {
        onCheckStart: async (progress) => {
          const promoted = await withProjectMutationLock(projectRoot, async () => {
            if (!loadDoingTask(stateManager, params.task_id)) return false;
            evidenceManager.save({
              ...inProgressEvidence,
              gate_0_attempt: { ...inProgressEvidence.gate_0_attempt!, current_check: { ...progress, started_at: new Date().toISOString() } },
            });
            return true;
          });
          if (!promoted) throw new Error("stale-attempt");
        },
      });
    } catch (error: unknown) {
      executionError = error instanceof Error ? error.message : String(error);
      gate0Result = { passed: false, checks: [{ name: "gate_0", passed: false, detail: `Gate 0 execution error: ${executionError}` }] };
    }
    const outcome = executionError ? "execution_error" : gate0Result.passed ? "passed" : gate0Result.checks.some((check) => check.timed_out) ? "timed_out" : gate0Result.checks.some((check) => check.cancelled) ? "cancelled" : "failed";
    const finishedAt = new Date().toISOString();
    const terminalEvidence: GateEvidence = {
      ...inProgressEvidence,
      passed: gate0Result.passed,
      timestamp: finishedAt,
      checks: gate0Result.checks,
      gate_0_attempt: { version: 1, id: attemptId, owner_id: task.worker?.owner_id ?? "legacy", started_at: startedAt, finished_at: finishedAt, outcome },
    };
    evidenceManager.saveGate0AttemptHistory(terminalEvidence);
    const terminalCommit = await withProjectMutationLock(projectRoot, async () => {
      const current = loadDoingTask(stateManager, params.task_id);
      if (!current) return false;
      const evidencePath = evidenceManager.promoteTerminalGate0Attempt(terminalEvidence);
      current.task.gate_0 = {
        passed: gate0Result.passed,
        evidence_path: evidencePath,
        coverage: gate0Result.coverage,
        lint_passed: gate0Result.checks.find((check) => check.name === "lint")?.passed,
        tests_passed: gate0Result.checks.find((check) => check.name === "tests")?.passed,
      };
      stateManager.save(current.state);
      return evidencePath;
    });
    if (!terminalCommit) return staleAttemptResult(params.task_id);
    const evidencePath = terminalCommit;
    if (executionError) {
      const failed = await withProjectMutationLock(projectRoot, async () => {
        if (!clearWorker(stateManager, params.task_id)) return false;
        stateManager.transition(params.task_id, "failed");
        return true;
      });
      if (!failed) return staleAttemptResult(params.task_id);
      return textResult(`Task ${params.task_id} failed because Gate 0 could not run.\n\n  [FAIL] gate_0: Gate 0 execution error: ${executionError}\n\nEvidence: ${evidencePath}`, true);
    }

  // 5b. Run post_task custom gates (only if Gate 0 passed)
  if (gate0Result.passed) {
    let customResult;
    try {
      customResult = await runCustomGates("post_task", params.task_id, cfg, projectRoot);
    } catch (error: unknown) {
      customResult = { passed: false, checks: [{ name: "custom_post_task", passed: false, detail: `Post-task custom gate execution error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
    if (!customResult.passed) {
      const failed = await withProjectMutationLock(projectRoot, async () => {
        const current = loadDoingTask(stateManager, params.task_id);
        if (!current) return false;
        evidenceManager.save({ gate: "custom_post_task", entity_id: params.task_id, passed: false, timestamp: new Date().toISOString(), checks: customResult.checks });
        current.task.gate_0 = { passed: false, evidence_path: evidencePath };
        delete current.task.worker;
        stateManager.save(current.state);
        stateManager.transition(params.task_id, "failed");
        return true;
      });
      if (!failed) return staleAttemptResult(params.task_id);
      const lines: string[] = [];
      lines.push(`Task ${params.task_id} passed Gate 0 but failed post_task custom gate.`);
      lines.push("");
      lines.push("Gate 0 checks:");
      for (const check of gate0Result.checks) {
        const icon = check.passed ? "PASS" : "FAIL";
        lines.push(`  [${icon}] ${check.name}: ${check.detail}`);
      }
      lines.push("");
      lines.push("Custom gate checks:");
      for (const check of customResult.checks) {
        const icon = check.passed ? "PASS" : "FAIL";
        lines.push(`  [${icon}] ${check.name}: ${check.detail}`);
      }
      activeTaskCompletions.delete(key);
      return textResult(lines.join("\n"), true);
    }
  }

  const transitioned = await withProjectMutationLock(projectRoot, async () => {
    if (!clearWorker(stateManager, params.task_id)) return false;
    stateManager.transition(params.task_id, gate0Result.passed ? "done" : "failed");
    return true;
  });
  if (!transitioned) return staleAttemptResult(params.task_id);

  // 7. Build response
  const lines: string[] = [];

  if (gate0Result.passed) {
    lines.push(`Task ${params.task_id} completed successfully.`);
  } else {
    lines.push(`Task ${params.task_id} failed Gate 0 checks.`);
  }

  lines.push("");
  lines.push("Checks:");
  for (const check of gate0Result.checks) {
    const icon = check.passed ? "PASS" : "FAIL";
    lines.push(`  [${icon}] ${check.name}: ${check.detail}`);
  }

  lines.push("");
  lines.push(`Evidence: ${evidencePath}`);

    return textResult(lines.join("\n"), !gate0Result.passed);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    const failed = await withProjectMutationLock(projectRoot, async () => {
      if (!clearWorker(stateManager, params.task_id)) return false;
      stateManager.transition(params.task_id, "failed");
      return true;
    });
    if (!failed) return staleAttemptResult(params.task_id);
    return textResult(`Task ${params.task_id} failed while initializing or persisting its Gate 0 attempt. The active attempt was cleared and the task can be retried.\n\n  [FAIL] gate_0: ${detail}`, true);
  } finally {
    activeTaskCompletions.delete(key);
  }
}

