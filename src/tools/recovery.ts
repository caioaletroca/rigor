/**
 * Recovery MCP tools: cycle_reset, task_manage, epic_manage, phase_manage, cycle_diagnose.
 *
 * cycle_reset    — previews or destroys the current cycle state + evidence.
 * task_manage    — force_status, skip, retry, reset_evidence for a task.
 * epic_manage    — force_status, reset_tasks, skip for an epic (optional cascade).
 * phase_manage   — force_status, skip for a phase (cascades to children).
 * cycle_diagnose — runs validation, detects stuck entities, audits evidence.
 */

import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { StateManager } from "../state/index.js";
import {
  EntityNotFoundError,
  InvalidTransitionError,
  validateState,
  detectStuckEntities,
} from "../state/index.js";
import type { Status } from "../state/index.js";
import { ALL_STATUSES } from "../state/index.js";
import type { EvidenceManager } from "../evidence/index.js";

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
// cycle_reset handler
// ---------------------------------------------------------------------------

export interface CycleResetParams {
  confirm: boolean;
}

export function handleCycleReset(
  params: CycleResetParams,
  stateManager: StateManager,
  evidenceManager: EvidenceManager,
  projectRoot: string,
): CallToolResult {
  const state = stateManager.load();
  if (state === null) {
    return textResult("No active cycle to reset.", true);
  }

  const statePath = join(projectRoot, ".rigor", "state.json");
  const evidenceDir = join(projectRoot, ".rigor", "evidence");

  // Count progress
  let tasksDone = 0;
  let tasksTotal = 0;
  let epicsDone = 0;
  let epicsTotal = 0;

  for (const phase of state.phases) {
    for (const epic of phase.epics) {
      epicsTotal++;
      if (epic.status === "done") {
        epicsDone++;
      }
      for (const task of epic.tasks) {
        tasksTotal++;
        if (task.status === "done") {
          tasksDone++;
        }
      }
    }
  }

  // Count evidence files
  let evidenceFileCount = 0;
  if (existsSync(evidenceDir)) {
    const files = readdirSync(evidenceDir);
    evidenceFileCount = files.filter((f) => f.endsWith(".json")).length;
  }

  if (!params.confirm) {
    const lines: string[] = [];
    lines.push("Cycle reset preview:");
    lines.push(`  Cycle ID: ${state.cycle_id}`);
    lines.push(`  Tasks: ${tasksDone}/${tasksTotal} done`);
    lines.push(`  Epics: ${epicsDone}/${epicsTotal} done`);
    lines.push(`  Evidence files: ${evidenceFileCount}`);
    lines.push("");
    lines.push("Run cycle_reset with confirm: true to proceed.");

    return textResult(lines.join("\n"));
  }

  // Delete state file
  if (existsSync(statePath)) {
    unlinkSync(statePath);
  }

  // Delete all evidence files (keep the directory)
  evidenceManager.clearAll();

  return textResult(
    `Cycle "${state.cycle_id}" has been reset. State and ${evidenceFileCount} evidence file(s) deleted.`,
  );
}

// ---------------------------------------------------------------------------
// task_retry handler
// ---------------------------------------------------------------------------

export interface TaskRetryParams {
  task_id: string;
}

export function handleTaskRetry(
  params: TaskRetryParams,
  stateManager: StateManager,
  evidenceManager: EvidenceManager,
  projectRoot: string,
): CallToolResult {
  // 1. Load state, verify cycle exists
  const state = stateManager.load();
  if (state === null) {
    return textResult("No active cycle. Run cycle_init first.", true);
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

  // 3. Task must be in "failed" status
  if (task.status !== "failed") {
    return textResult(
      `Task "${params.task_id}" is in "${task.status}" status. ` +
        `Only "failed" tasks can be retried.`,
      true,
    );
  }

  // 4. Load previous gate_0 evidence to extract failure reason
  const previousEvidence = evidenceManager.load("gate_0", params.task_id);
  let failureReason = "No prior evidence found.";
  if (previousEvidence !== null) {
    const failedChecks = previousEvidence.checks.filter((c) => !c.passed);
    if (failedChecks.length > 0) {
      failureReason = failedChecks
        .map((c) => `${c.name}: ${c.detail}`)
        .join("; ");
    } else {
      failureReason = "Previous evidence found but no failed checks recorded.";
    }
  }

  // 5. Delete the gate_0 evidence file on disk if it exists
  evidenceManager.delete("gate_0", params.task_id);

  // 6. Reset the task's gate_0 field in state
  const freshState = stateManager.load();
  if (freshState !== null) {
    for (const phase of freshState.phases) {
      for (const epic of phase.epics) {
        for (const t of epic.tasks) {
          if (t.id === params.task_id) {
            t.gate_0 = { passed: false };
          }
        }
      }
    }
    stateManager.save(freshState);
  }

  // 7. Return confirmation with previous failure reason
  const lines: string[] = [];
  lines.push(`Task "${params.task_id}" ready for retry.`);
  lines.push(`Previous failure: ${failureReason}`);
  lines.push("");
  lines.push("Call task_start to begin work on this task again.");

  return textResult(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// task_manage handler
// ---------------------------------------------------------------------------

export interface TaskManageParams {
  task_id: string;
  action: "force_status" | "skip" | "retry" | "reset_evidence";
  target_status?: string;
  confirm: boolean;
}

/**
 * Determine whether `toStatus` is a backward transition relative to
 * `fromStatus`. The natural forward order is:
 *   pending (0) -> doing (1) -> done (2) / failed (3) -> skipped (4)
 *
 * Any move to a numerically lower status counts as backward and triggers
 * evidence cleanup.
 */
const STATUS_ORDER: Record<Status, number> = {
  pending: 0,
  doing: 1,
  done: 2,
  failed: 3,
  skipped: 4,
};

function isBackwardTransition(from: Status, to: Status): boolean {
  return STATUS_ORDER[to] < STATUS_ORDER[from];
}

export function handleTaskManage(
  params: TaskManageParams,
  stateManager: StateManager,
  evidenceManager: EvidenceManager,
  _projectRoot: string,
): CallToolResult {
  const state = stateManager.load();
  if (state === null) {
    return textResult("No active cycle. Run cycle_init first.", true);
  }

  // Locate the task
  let task;
  try {
    task = stateManager.getTask(params.task_id);
  } catch (error: unknown) {
    if (error instanceof EntityNotFoundError) {
      return textResult(`Task "${params.task_id}" not found.`, true);
    }
    throw error;
  }

  switch (params.action) {
    // ----- force_status -----
    case "force_status": {
      if (!params.target_status) {
        return textResult(
          'force_status requires "target_status" parameter.',
          true,
        );
      }
      if (!ALL_STATUSES.has(params.target_status as Status)) {
        return textResult(
          `Invalid target_status "${params.target_status}". Valid values: pending, doing, done, failed, skipped.`,
          true,
        );
      }
      const targetStatus = params.target_status as Status;
      const willCleanEvidence = isBackwardTransition(task.status, targetStatus);

      if (!params.confirm) {
        const lines: string[] = [];
        lines.push("task_manage force_status preview:");
        lines.push(`  Task: ${params.task_id} (${task.name})`);
        lines.push(`  Current status: ${task.status}`);
        lines.push(`  Target status: ${targetStatus}`);
        if (willCleanEvidence) {
          lines.push("  Evidence: will be deleted (backward transition)");
        } else {
          lines.push("  Evidence: will be preserved");
        }
        lines.push("");
        lines.push("Run task_manage with confirm: true to apply.");
        return textResult(lines.join("\n"));
      }

      if (willCleanEvidence) {
        evidenceManager.deleteAll(params.task_id);
      }
      stateManager.forceTransition(params.task_id, targetStatus);
      return textResult(
        `Task "${params.task_id}" forced from "${task.status}" to "${targetStatus}".` +
          (willCleanEvidence ? " Evidence cleared." : ""),
      );
    }

    // ----- skip -----
    case "skip": {
      if (!params.confirm) {
        const lines: string[] = [];
        lines.push("task_manage skip preview:");
        lines.push(`  Task: ${params.task_id} (${task.name})`);
        lines.push(`  Current status: ${task.status}`);
        lines.push(`  Target status: skipped`);
        lines.push("");
        lines.push("Run task_manage with confirm: true to apply.");
        return textResult(lines.join("\n"));
      }

      try {
        stateManager.transition(params.task_id, "skipped");
      } catch (error: unknown) {
        if (error instanceof InvalidTransitionError) {
          return textResult(
            `Cannot skip task "${params.task_id}": transition from "${task.status}" to "skipped" is not allowed.`,
            true,
          );
        }
        throw error;
      }
      return textResult(
        `Task "${params.task_id}" transitioned to "skipped".`,
      );
    }

    // ----- retry -----
    case "retry": {
      if (!params.confirm) {
        if (task.status !== "failed") {
          return textResult(
            `task_manage retry preview:\n  Task "${params.task_id}" is in "${task.status}" status.\n  Only "failed" tasks can be retried.`,
            true,
          );
        }
        const previousEvidence = evidenceManager.load("gate_0", params.task_id);
        let failureInfo = "No prior evidence found.";
        if (previousEvidence !== null) {
          const failedChecks = previousEvidence.checks.filter((c) => !c.passed);
          if (failedChecks.length > 0) {
            failureInfo = failedChecks
              .map((c) => `${c.name}: ${c.detail}`)
              .join("; ");
          } else {
            failureInfo = "Previous evidence found but no failed checks recorded.";
          }
        }
        const lines: string[] = [];
        lines.push("task_manage retry preview:");
        lines.push(`  Task: ${params.task_id} (${task.name})`);
        lines.push(`  Current status: ${task.status}`);
        lines.push(`  Previous failure: ${failureInfo}`);
        lines.push("  Action: clear gate_0 evidence and reset gate_0 state");
        lines.push("");
        lines.push("Run task_manage with confirm: true to apply.");
        return textResult(lines.join("\n"));
      }

      // Delegate to the existing handleTaskRetry logic
      return handleTaskRetry(
        { task_id: params.task_id },
        stateManager,
        evidenceManager,
        _projectRoot,
      );
    }

    // ----- reset_evidence -----
    case "reset_evidence": {
      if (!params.confirm) {
        const gates = ["gate_0", "gate_8", "gate_9"];
        const existing = gates.filter(
          (g) => evidenceManager.load(g, params.task_id) !== null,
        );
        const lines: string[] = [];
        lines.push("task_manage reset_evidence preview:");
        lines.push(`  Task: ${params.task_id} (${task.name})`);
        lines.push(`  Current status: ${task.status} (will NOT change)`);
        lines.push(
          `  Evidence to delete: ${existing.length > 0 ? existing.join(", ") : "none"}`,
        );
        lines.push("");
        lines.push("Run task_manage with confirm: true to apply.");
        return textResult(lines.join("\n"));
      }

      const deleted = evidenceManager.deleteAll(params.task_id);
      return textResult(
        `Evidence for task "${params.task_id}" cleared. ${deleted} file(s) deleted. Status unchanged (${task.status}).`,
      );
    }

    default:
      return textResult(`Unknown action "${params.action}".`, true);
  }
}

// ---------------------------------------------------------------------------
// epic_manage handler
// ---------------------------------------------------------------------------

export interface EpicManageParams {
  epic_id: string;
  action: "force_status" | "reset_tasks" | "skip";
  target_status?: string;
  cascade: boolean;
  confirm: boolean;
}

export function handleEpicManage(
  params: EpicManageParams,
  stateManager: StateManager,
  evidenceManager: EvidenceManager,
  _projectRoot: string,
): CallToolResult {
  const state = stateManager.load();
  if (state === null) {
    return textResult("No active cycle. Run cycle_init first.", true);
  }

  // Locate the epic
  let epic;
  try {
    epic = stateManager.getEpic(params.epic_id);
  } catch (error: unknown) {
    if (error instanceof EntityNotFoundError) {
      return textResult(`Epic "${params.epic_id}" not found.`, true);
    }
    throw error;
  }

  switch (params.action) {
    // ----- force_status -----
    case "force_status": {
      if (!params.target_status) {
        return textResult(
          'force_status requires "target_status" parameter.',
          true,
        );
      }
      if (!ALL_STATUSES.has(params.target_status as Status)) {
        return textResult(
          `Invalid target_status "${params.target_status}". Valid values: pending, doing, done, failed, skipped.`,
          true,
        );
      }
      const targetStatus = params.target_status as Status;

      if (!params.confirm) {
        const lines: string[] = [];
        lines.push("epic_manage force_status preview:");
        lines.push(`  Epic: ${params.epic_id} (${epic.name})`);
        lines.push(`  Current status: ${epic.status}`);
        lines.push(`  Target status: ${targetStatus}`);
        lines.push(`  Cascade to tasks: ${params.cascade}`);
        if (params.cascade) {
          lines.push(`  Tasks affected: ${epic.tasks.length}`);
          for (const t of epic.tasks) {
            lines.push(`    ${t.id} (${t.name}): ${t.status} -> ${targetStatus}`);
          }
        }
        lines.push("");
        lines.push("Run epic_manage with confirm: true to apply.");
        return textResult(lines.join("\n"));
      }

      stateManager.forceTransition(params.epic_id, targetStatus);
      let cascadeCount = 0;
      if (params.cascade) {
        for (const t of epic.tasks) {
          if (isBackwardTransition(t.status, targetStatus)) {
            evidenceManager.deleteAll(t.id);
          }
          stateManager.forceTransition(t.id, targetStatus);
          cascadeCount++;
        }
      }
      return textResult(
        `Epic "${params.epic_id}" forced to "${targetStatus}".` +
          (params.cascade ? ` ${cascadeCount} task(s) also updated.` : ""),
      );
    }

    // ----- reset_tasks -----
    case "reset_tasks": {
      if (!params.confirm) {
        const lines: string[] = [];
        lines.push("epic_manage reset_tasks preview:");
        lines.push(`  Epic: ${params.epic_id} (${epic.name})`);
        lines.push(`  Tasks to reset: ${epic.tasks.length}`);
        for (const t of epic.tasks) {
          lines.push(`    ${t.id} (${t.name}): ${t.status} -> pending`);
        }
        lines.push("  Evidence: will be deleted for all tasks");
        lines.push("");
        lines.push("Run epic_manage with confirm: true to apply.");
        return textResult(lines.join("\n"));
      }

      let evidenceDeleted = 0;
      for (const t of epic.tasks) {
        evidenceDeleted += evidenceManager.deleteAll(t.id);
        stateManager.forceTransition(t.id, "pending");
      }
      return textResult(
        `All ${epic.tasks.length} task(s) in epic "${params.epic_id}" reset to "pending". ${evidenceDeleted} evidence file(s) deleted.`,
      );
    }

    // ----- skip -----
    case "skip": {
      if (!params.confirm) {
        const lines: string[] = [];
        lines.push("epic_manage skip preview:");
        lines.push(`  Epic: ${params.epic_id} (${epic.name})`);
        lines.push(`  Current status: ${epic.status}`);
        lines.push(`  Target status: skipped`);
        lines.push(`  Cascade to tasks: ${params.cascade}`);
        if (params.cascade) {
          lines.push(`  Tasks affected: ${epic.tasks.length}`);
          for (const t of epic.tasks) {
            lines.push(`    ${t.id} (${t.name}): ${t.status} -> skipped`);
          }
        }
        lines.push("");
        lines.push("Run epic_manage with confirm: true to apply.");
        return textResult(lines.join("\n"));
      }

      try {
        stateManager.transition(params.epic_id, "skipped");
      } catch (error: unknown) {
        if (error instanceof InvalidTransitionError) {
          return textResult(
            `Cannot skip epic "${params.epic_id}": transition from "${epic.status}" to "skipped" is not allowed.`,
            true,
          );
        }
        throw error;
      }

      let cascadeCount = 0;
      if (params.cascade) {
        // Re-load state after the epic transition
        for (const t of epic.tasks) {
          // skipped is a terminal state — if already skipped, skip it
          if (t.status === "skipped") continue;
          try {
            stateManager.transition(t.id, "skipped");
            cascadeCount++;
          } catch {
            // Use forceTransition as fallback (e.g. if already in skipped)
            stateManager.forceTransition(t.id, "skipped");
            cascadeCount++;
          }
        }
      }

      return textResult(
        `Epic "${params.epic_id}" transitioned to "skipped".` +
          (params.cascade ? ` ${cascadeCount} task(s) also skipped.` : ""),
      );
    }

    default:
      return textResult(`Unknown action "${params.action}".`, true);
  }
}

// ---------------------------------------------------------------------------
// phase_manage handler
// ---------------------------------------------------------------------------

export interface PhaseManageParams {
  phase_id: string;
  action: "force_status" | "skip";
  target_status?: string;
  confirm: boolean;
}

export function handlePhaseManage(
  params: PhaseManageParams,
  stateManager: StateManager,
  evidenceManager: EvidenceManager,
  _projectRoot: string,
): CallToolResult {
  const state = stateManager.load();
  if (state === null) {
    return textResult("No active cycle. Run cycle_init first.", true);
  }

  const phaseIdNum = Number(params.phase_id);
  if (!Number.isInteger(phaseIdNum)) {
    return textResult(
      `Invalid phase_id "${params.phase_id}". Phase IDs must be numeric (e.g. "1", "2").`,
      true,
    );
  }

  // Locate the phase
  let phase;
  try {
    phase = stateManager.getPhase(phaseIdNum);
  } catch (error: unknown) {
    if (error instanceof EntityNotFoundError) {
      return textResult(`Phase "${params.phase_id}" not found.`, true);
    }
    throw error;
  }

  switch (params.action) {
    // ----- force_status -----
    case "force_status": {
      if (!params.target_status) {
        return textResult(
          'force_status requires "target_status" parameter.',
          true,
        );
      }
      if (!ALL_STATUSES.has(params.target_status as Status)) {
        return textResult(
          `Invalid target_status "${params.target_status}". Valid values: pending, doing, done, failed, skipped.`,
          true,
        );
      }
      const targetStatus = params.target_status as Status;

      if (!params.confirm) {
        const lines: string[] = [];
        lines.push("phase_manage force_status preview:");
        lines.push(`  Phase: ${params.phase_id}`);
        lines.push(`  Current status: ${phase.status}`);
        lines.push(`  Target status: ${targetStatus}`);
        lines.push("");
        lines.push("Run phase_manage with confirm: true to apply.");
        return textResult(lines.join("\n"));
      }

      stateManager.forceTransition(params.phase_id, targetStatus);
      return textResult(
        `Phase "${params.phase_id}" forced from "${phase.status}" to "${targetStatus}".`,
      );
    }

    // ----- skip -----
    case "skip": {
      // Count children for preview
      let totalEpics = 0;
      let totalTasks = 0;
      for (const epic of phase.epics) {
        totalEpics++;
        totalTasks += epic.tasks.length;
      }

      if (!params.confirm) {
        const lines: string[] = [];
        lines.push("phase_manage skip preview:");
        lines.push(`  Phase: ${params.phase_id}`);
        lines.push(`  Current status: ${phase.status}`);
        lines.push(`  Target status: skipped`);
        lines.push(`  Cascade: ${totalEpics} epic(s), ${totalTasks} task(s) will also be skipped`);
        for (const epic of phase.epics) {
          lines.push(`    Epic ${epic.id} (${epic.name}): ${epic.status} -> skipped`);
          for (const t of epic.tasks) {
            lines.push(`      Task ${t.id} (${t.name}): ${t.status} -> skipped`);
          }
        }
        lines.push("");
        lines.push("Run phase_manage with confirm: true to apply.");
        return textResult(lines.join("\n"));
      }

      // Force-transition phase and all children to skipped
      stateManager.forceTransition(params.phase_id, "skipped");
      for (const epic of phase.epics) {
        if (epic.status !== "skipped") {
          stateManager.forceTransition(epic.id, "skipped");
        }
        for (const t of epic.tasks) {
          if (t.status !== "skipped") {
            stateManager.forceTransition(t.id, "skipped");
          }
        }
      }

      return textResult(
        `Phase "${params.phase_id}" and all children (${totalEpics} epic(s), ${totalTasks} task(s)) skipped.`,
      );
    }

    default:
      return textResult(`Unknown action "${params.action}".`, true);
  }
}

// ---------------------------------------------------------------------------
// cycle_diagnose handler
// ---------------------------------------------------------------------------

export function handleCycleDiagnose(
  stateManager: StateManager,
  evidenceManager: EvidenceManager,
  projectRoot: string,
): CallToolResult {
  // 1. Load state
  const state = stateManager.load();
  if (state === null) {
    return textResult("No active cycle.");
  }

  // 2. Run validation
  const validation = validateState(state, projectRoot);

  // 3. Detect stuck entities
  const stuck = detectStuckEntities(state);

  // 4. Audit evidence completeness
  const missingEvidence: string[] = [];

  for (const phase of state.phases) {
    for (const epic of phase.epics) {
      // Done tasks should have gate_0 evidence
      for (const task of epic.tasks) {
        if (task.status === "done") {
          const evidence = evidenceManager.load("gate_0", task.id);
          if (evidence === null) {
            missingEvidence.push(`Task ${task.id}: missing gate_0 evidence`);
          }
        }
      }

      // Done epics should have gate_8 and gate_9 evidence
      if (epic.status === "done") {
        const gate8 = evidenceManager.load("gate_8", epic.id);
        if (gate8 === null) {
          missingEvidence.push(`Epic ${epic.id}: missing gate_8 evidence`);
        }
        const gate9 = evidenceManager.load("gate_9", epic.id);
        if (gate9 === null) {
          missingEvidence.push(`Epic ${epic.id}: missing gate_9 evidence`);
        }
      }
    }
  }

  // 5. Determine health status
  let health: "healthy" | "degraded" | "corrupt";
  if (validation.errors.length > 0) {
    health = "corrupt";
  } else if (
    validation.warnings.length > 0 ||
    stuck.length > 0 ||
    missingEvidence.length > 0
  ) {
    health = "degraded";
  } else {
    health = "healthy";
  }

  // 6. Compute progress
  let tasksDone = 0;
  let tasksTotal = 0;
  let epicsDone = 0;
  let epicsTotal = 0;

  for (const phase of state.phases) {
    for (const epic of phase.epics) {
      epicsTotal++;
      if (epic.status === "done") {
        epicsDone++;
      }
      for (const task of epic.tasks) {
        tasksTotal++;
        if (task.status === "done") {
          tasksDone++;
        }
      }
    }
  }

  // 7. Build report
  const lines: string[] = [];

  lines.push(`Health: ${health}`);
  lines.push(`Cycle: ${state.cycle_id}`);
  lines.push(`Current phase: ${state.current_phase}`);
  lines.push(`Progress: ${tasksDone}/${tasksTotal} tasks, ${epicsDone}/${epicsTotal} epics`);

  // Issues
  if (validation.errors.length > 0 || validation.warnings.length > 0) {
    lines.push("");
    lines.push("Issues:");
    for (const e of validation.errors) {
      lines.push(`  [ERROR] ${e}`);
    }
    for (const w of validation.warnings) {
      lines.push(`  [WARNING] ${w}`);
    }
  }

  // Stuck entities
  if (stuck.length > 0) {
    lines.push("");
    lines.push("Stuck entities:");
    for (const s of stuck) {
      let suggestion: string;
      if (s.type === "task") {
        suggestion = "verify if work is ongoing or run task_retry if failed";
      } else if (s.type === "epic") {
        suggestion = "verify if review is ongoing";
      } else {
        suggestion = "check phase_advance status";
      }
      lines.push(`  ${s.type} ${s.id} (${s.name}): ${suggestion}`);
    }
  }

  // Evidence audit
  if (missingEvidence.length > 0) {
    lines.push("");
    lines.push(`Evidence audit: ${missingEvidence.length} missing`);
    for (const m of missingEvidence) {
      lines.push(`  ${m}`);
    }
  }

  return textResult(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerRecoveryTools(
  server: McpServer,
  stateManager: StateManager,
  evidenceManager: EvidenceManager,
  projectRoot: string,
): void {
  server.tool(
    "cycle_reset",
    "Preview or reset the current cycle — deletes state and evidence files",
    { confirm: z.boolean().describe("Set to true to actually delete; false for preview") },
    async (params) => {
      return handleCycleReset(params, stateManager, evidenceManager, projectRoot);
    },
  );

  server.tool(
    "task_manage",
    "Manage a task: force_status, skip, retry, or reset_evidence. Uses preview/confirm pattern.",
    {
      task_id: z.string().describe("Task id (e.g. 1.1.1)"),
      action: z.enum(["force_status", "skip", "retry", "reset_evidence"]).describe("Action to perform"),
      target_status: z.string().optional().describe("Required for force_status. Valid: pending, doing, done, failed, skipped"),
      confirm: z.boolean().default(false).describe("Set to true to apply; false (default) for preview"),
    },
    async (params) => {
      return handleTaskManage(params, stateManager, evidenceManager, projectRoot);
    },
  );

  server.tool(
    "epic_manage",
    "Manage an epic: force_status, reset_tasks, or skip. Optional cascade to child tasks. Uses preview/confirm pattern.",
    {
      epic_id: z.string().describe("Epic id (e.g. 1.1)"),
      action: z.enum(["force_status", "reset_tasks", "skip"]).describe("Action to perform"),
      target_status: z.string().optional().describe("Required for force_status. Valid: pending, doing, done, failed, skipped"),
      cascade: z.boolean().default(false).describe("Also apply action to child tasks (force_status, skip)"),
      confirm: z.boolean().default(false).describe("Set to true to apply; false (default) for preview"),
    },
    async (params) => {
      return handleEpicManage(params, stateManager, evidenceManager, projectRoot);
    },
  );

  server.tool(
    "phase_manage",
    "Manage a phase: force_status or skip. Skip always cascades to all child epics and tasks. Uses preview/confirm pattern.",
    {
      phase_id: z.string().describe("Phase id (e.g. 1 or 2)"),
      action: z.enum(["force_status", "skip"]).describe("Action to perform"),
      target_status: z.string().optional().describe("Required for force_status. Valid: pending, doing, done, failed, skipped"),
      confirm: z.boolean().default(false).describe("Set to true to apply; false (default) for preview"),
    },
    async (params) => {
      return handlePhaseManage(params, stateManager, evidenceManager, projectRoot);
    },
  );

  server.tool(
    "cycle_diagnose",
    "Run diagnostics on the current cycle — validation, stuck detection, evidence audit",
    async () => {
      return handleCycleDiagnose(stateManager, evidenceManager, projectRoot);
    },
  );
}
