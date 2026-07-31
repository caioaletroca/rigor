/**
 * Cycle lifecycle MCP tools: cycle_init and cycle_status.
 *
 * Exported handler functions are pure logic that accept dependencies
 * and return the MCP CallToolResult shape. This keeps them testable
 * without spinning up a real MCP transport.
 */

import { resolve, isAbsolute } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { StateManager, PhaseState, EpicState, TaskState } from "../state/index.js";
import type { RigorConfig } from "../config/index.js";
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
}

export function handleCycleInit(
  params: CycleInitParams,
  stateManager: StateManager,
  projectRoot: string,
): CallToolResult {
  const resolvedPath = isAbsolute(params.plan_path)
    ? params.plan_path
    : resolve(projectRoot, params.plan_path);

  const existing = stateManager.load();
  if (existing !== null) {
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
// cycle_reload handler
// ---------------------------------------------------------------------------

export interface CycleReloadParams {
  /** Optional plan path override. Defaults to the cycle's stored plan_path. */
  plan_path?: string;
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
): CallToolResult {
  const state = stateManager.load();
  if (state === null) {
    return textResult("No active cycle. Run cycle_init first.", true);
  }

  const planPath = params.plan_path
    ? isAbsolute(params.plan_path)
      ? params.plan_path
      : resolve(projectRoot, params.plan_path)
    : state.plan_path;

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

  stateManager.save(state);

  const summary = {
    reloaded_from: planPath,
    added,
    note: "Existing phases, epics, and tasks kept their status and evidence; only new entities were added.",
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
    { plan_path: z.string().describe("Relative or absolute path to the plan.md file") },
    async (params) => {
      return handleCycleInit(params, stateManager, projectRoot);
    },
  );

  server.tool(
    "cycle_reload",
    "Re-parse the plan and merge new phases/epics/tasks into the running cycle without losing progress (rolling-wave elaboration)",
    {
      plan_path: z
        .string()
        .optional()
        .describe("Optional plan path override; defaults to the cycle's stored plan_path"),
    },
    async (params) => {
      return handleCycleReload(params, stateManager, projectRoot);
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
