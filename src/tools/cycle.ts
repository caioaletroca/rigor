/**
 * Cycle lifecycle MCP tools: cycle_init and cycle_status.
 *
 * Exported handler functions are pure logic that accept dependencies
 * and return the MCP CallToolResult shape. This keeps them testable
 * without spinning up a real MCP transport.
 */

import { resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { StateManager, PhaseState, EpicState, TaskState } from "../state/index.js";
import type { RigorConfig } from "../config/index.js";
import { inspectWorkspace, WorkspaceInspectionError } from "../workspace/index.js";
import { parsePlan } from "../plan/index.js";
import type { ParsedPhase, ParsedEpic, ParsedTask } from "../plan/index.js";

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function textResult(text: string, isError?: boolean): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
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
  allow_shared_workspace?: boolean;
}

const WORKTREE_REMEDIATION =
  "Run rigor:worktree to create an isolated worktree and feature branch, then re-run cycle_init from it.";

export function handleCycleInit(
  params: CycleInitParams,
  stateManager: StateManager,
  projectRoot: string,
  config: RigorConfig,
): CallToolResult {
  if (
    !params.allow_shared_workspace &&
    (config.workspace.require_worktree || config.workspace.require_feature_branch)
  ) {
    let workspace;
    try {
      workspace = inspectWorkspace(projectRoot);
    } catch (err) {
      if (err instanceof WorkspaceInspectionError) {
        return textResult(err.message, true);
      }
      throw err;
    }

    if (workspace.detached) {
      return textResult(
        `A cycle cannot be anchored to a detached HEAD. ${WORKTREE_REMEDIATION}`,
        true,
      );
    }

    if (
      config.workspace.require_feature_branch &&
      workspace.branch !== null &&
      config.workspace.base_branches.includes(workspace.branch)
    ) {
      return textResult(
        `Branch '${workspace.branch}' is an integration branch, not an agent workspace. ${WORKTREE_REMEDIATION}`,
        true,
      );
    }

    if (config.workspace.require_worktree && !workspace.is_linked_worktree) {
      return textResult(
        `A cycle must run in a dedicated worktree, not the main checkout. ${WORKTREE_REMEDIATION}`,
        true,
      );
    }
  } else if (!config.workspace.allow_override) {
    return textResult(
      "allow_shared_workspace is disabled by project config (workspace.allow_override is false).",
      true,
    );
  }

  const resolvedPath = resolve(projectRoot, params.plan_path);

  const existing = stateManager.load();
  if (existing !== null) {
    const existingPlanPath = resolve(projectRoot, existing.plan_path);
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

  const state = stateManager.init(resolvedPath, phases);

  let epicCount = 0;
  let taskCount = 0;
  for (const phase of state.phases) {
    epicCount += phase.epics.length;
    for (const epic of phase.epics) {
      taskCount += epic.tasks.length;
    }
  }

  const summary = {
    cycle_id: state.cycle_id,
    plan_path: state.plan_path,
    phases: state.phases.length,
    epics: epicCount,
    tasks: taskCount,
  };

  return textResult(JSON.stringify(summary, null, 2));
}

// ---------------------------------------------------------------------------
// cycle_status handler
// ---------------------------------------------------------------------------

export function handleCycleStatus(
  stateManager: StateManager,
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

  // Find the first task with status "doing" across all phases
  let activeTask: { id: string; name: string; epicId: string } | null = null;
  for (const phase of state.phases) {
    for (const epic of phase.epics) {
      for (const task of epic.tasks) {
        if (task.status === "doing") {
          activeTask = { id: task.id, name: task.name, epicId: epic.id };
          break;
        }
      }
      if (activeTask) break;
    }
    if (activeTask) break;
  }

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
): void {
  server.tool(
    "cycle_init",
    "Initialize a new development cycle from a plan.md file",
    {
      plan_path: z.string().describe("Relative or absolute path to the plan.md file"),
      allow_shared_workspace: z.boolean().optional(),
    },
    async (params) => {
      return handleCycleInit(params, stateManager, projectRoot, _config);
    },
  );

  server.tool(
    "cycle_status",
    "Show the current cycle status, progress, and active task",
    async () => {
      return handleCycleStatus(stateManager);
    },
  );
}
