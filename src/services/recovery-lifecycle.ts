import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { responseResult } from "../tools/lifecycle.js";
import type { StateManager } from "../state/index.js";
import { EntityNotFoundError, InvalidTransitionError, validateState, detectStuckEntities, ALL_STATUSES } from "../state/index.js";
import type { Status } from "../state/index.js";
import { classifyGate0Attempt } from "../evidence/index.js";
import type { EvidenceManager } from "../evidence/index.js";
import { DEFAULTS } from "../config/index.js";
import type { RigorConfig } from "../config/index.js";
import { withProjectMutationLock } from "../lifecycle/index.js";
import { isGate0AttemptActive } from "./task-lifecycle.js";

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function textResult(text: string, isError?: boolean): CallToolResult {
  return responseResult(text, { error: isError });
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
): CallToolResult | Promise<CallToolResult> {
  if (!params.confirm) return handleCycleResetUnlocked(params, stateManager, evidenceManager, projectRoot);
  const preflight = handleCycleResetUnlocked({ confirm: false }, stateManager, evidenceManager, projectRoot);
  if (preflight.isError) return preflight;
  return withProjectMutationLock(projectRoot, async () => handleCycleResetUnlocked(params, stateManager, evidenceManager, projectRoot));
}

function handleCycleResetUnlocked(
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

  for (const phase of state.phases) {
    for (const epic of phase.epics) {
      for (const task of epic.tasks) {
        const attempt = evidenceManager.load("gate_0", task.id)?.gate_0_attempt;
        if (
          attempt &&
          !attempt.finished_at &&
          isGate0AttemptActive(projectRoot, task.id, attempt.id)
        ) {
          return textResult(
            `Cannot reset cycle while Gate 0 attempt ${attempt.id} for task ${task.id} is executing.`,
            true,
          );
        }
      }
    }
  }

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
  const evidenceFileCount = existsSync(evidenceDir) ? evidenceManager.countAll() : 0;

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
// task_retry handler (kept for backward-compat; retry action in task_manage
// delegates here)
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

  // 5. Clear only the current Gate 0 summary; terminal attempt history is retained.
  evidenceManager.delete("gate_0", params.task_id);

  // 6. Reset the task's gate_0 field in state
  const freshState = stateManager.load();
  if (freshState !== null) {
    for (const phase of freshState.phases) {
      for (const epic of phase.epics) {
        for (const t of epic.tasks) {
          if (t.id === params.task_id) {
            t.gate_0 = { passed: false };
            delete t.lease;
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
  owner_id?: string;
  attempt_id?: string;
  takeover?: boolean;
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
  projectRoot: string,
): CallToolResult | Promise<CallToolResult> {
  if (!params.confirm) return handleTaskManageUnlocked(params, stateManager, evidenceManager, projectRoot);
  return withProjectMutationLock(projectRoot, async () => handleTaskManageUnlocked(params, stateManager, evidenceManager, projectRoot));
}

function handleTaskManageUnlocked(
  params: TaskManageParams,
  stateManager: StateManager,
  evidenceManager: EvidenceManager,
  projectRoot: string,
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

  const hasOwner = params.owner_id !== undefined;
  const hasAttempt = params.attempt_id !== undefined;
  if (hasOwner !== hasAttempt) {
    return textResult(`Task "${params.task_id}" requires both owner_id and attempt_id together.`, true);
  }
  if (task.lease) {
    const expiresAt = Date.parse(task.lease.lease_expires_at);
    if (!Number.isFinite(expiresAt)) {
      return textResult(`Task "${params.task_id}" has an invalid lease expiration timestamp.`, true);
    }
    const active = expiresAt > Date.now();
    const matches = hasOwner && task.lease.owner_id === params.owner_id && task.lease.attempt_id === params.attempt_id;
    if (active && !matches) {
      return textResult(`Task "${params.task_id}" is owned by "${task.lease.owner_id}" until ${task.lease.lease_expires_at}.`, true);
    }
    if (!active && task.status === "doing" && params.confirm && !params.takeover && !matches) {
      return textResult(`Task "${params.task_id}" lease expired. Explicit takeover is required.`, true);
    }
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
        evidenceManager.deleteTaskEvidence(params.task_id);
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
        projectRoot,
      );
    }

    // ----- reset_evidence -----
    case "reset_evidence": {
      if (!params.confirm) {
        const evidenceCount = evidenceManager.taskEvidenceCount(params.task_id);
        const lines: string[] = [];
        lines.push("task_manage reset_evidence preview:");
        lines.push(`  Task: ${params.task_id} (${task.name})`);
        lines.push(`  Current status: ${task.status} (will NOT change)`);
        lines.push(`  Task evidence to delete: ${evidenceCount} file(s) (gate_0, history, gate_1, custom_post_task)`);
        lines.push("");
        lines.push("Run task_manage with confirm: true to apply.");
        return textResult(lines.join("\n"));
      }

      const deleted = evidenceManager.deleteTaskEvidence(params.task_id);
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
  projectRoot: string,
): CallToolResult | Promise<CallToolResult> {
  if (!params.confirm) return handleEpicManageUnlocked(params, stateManager, evidenceManager);
  return withProjectMutationLock(projectRoot, async () => handleEpicManageUnlocked(params, stateManager, evidenceManager));
}

function handleEpicManageUnlocked(
  params: EpicManageParams,
  stateManager: StateManager,
  evidenceManager: EvidenceManager,
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
            const cleanup = isBackwardTransition(t.status, targetStatus)
              ? `; ${evidenceManager.taskEvidenceCount(t.id)} task evidence file(s) deleted`
              : "; evidence preserved";
            lines.push(`    ${t.id} (${t.name}): ${t.status} -> ${targetStatus}${cleanup}`);
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
            evidenceManager.deleteTaskEvidence(t.id);
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
        const evidenceCount = epic.tasks.reduce(
          (count, task) => count + evidenceManager.taskEvidenceCount(task.id),
          0,
        );
        lines.push(`  Task evidence: ${evidenceCount} file(s) will be deleted (gate_0, history, gate_1, custom_post_task)`);
        lines.push("");
        lines.push("Run epic_manage with confirm: true to apply.");
        return textResult(lines.join("\n"));
      }

      let evidenceDeleted = 0;
      for (const t of epic.tasks) {
        evidenceDeleted += evidenceManager.deleteTaskEvidence(t.id);
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
  projectRoot: string,
): CallToolResult | Promise<CallToolResult> {
  if (!params.confirm) return handlePhaseManageUnlocked(params, stateManager, evidenceManager);
  return withProjectMutationLock(projectRoot, async () => handlePhaseManageUnlocked(params, stateManager, evidenceManager));
}

function handlePhaseManageUnlocked(
  params: PhaseManageParams,
  stateManager: StateManager,
  evidenceManager: EvidenceManager,
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
// Persisted Gate 0 attempt reconciliation
// ---------------------------------------------------------------------------

export interface Gate0RecoveryOutcome {
  taskId: string;
  taskName: string;
  classification: NonNullable<ReturnType<typeof classifyGate0Attempt>> | "post_task_unproven";
  outcome?: string;
}

function terminalGate0Mismatches(
  stateManager: StateManager,
  evidenceManager: EvidenceManager,
): Gate0RecoveryOutcome[] {
  const state = stateManager.load();
  if (state === null) return [];

  return state.phases.flatMap((phase) => phase.epics.flatMap((epic) => epic.tasks.flatMap((task) => {
    if (task.status === "doing") return [];
    const evidence = evidenceManager.load("gate_0", task.id);
    const attempt = evidence?.gate_0_attempt;
    if (!attempt?.finished_at) return [];
    const classification = classifyGate0Attempt(evidence, task.status, false);
    return classification === "inconsistent"
      ? [{ taskId: task.id, taskName: task.name, classification, outcome: attempt.outcome }]
      : [];
  })));
}

export function reconcilePersistedGate0Attempts(
  stateManager: StateManager,
  evidenceManager: EvidenceManager,
  projectRoot: string,
  config: RigorConfig = DEFAULTS,
): Gate0RecoveryOutcome[] {
  const state = stateManager.load();
  if (state === null) return [];
  const outcomes: Gate0RecoveryOutcome[] = [];

  for (const phase of state.phases) {
    for (const epic of phase.epics) {
      for (const task of epic.tasks) {
        if (task.status !== "doing") continue;
        let evidence = evidenceManager.load("gate_0", task.id);
        let attempt = evidence?.gate_0_attempt;
        const isActive = Boolean(attempt && isGate0AttemptActive(projectRoot, task.id, attempt.id));
        const terminalEvidence = !evidence && task.gate_0.evidence_path
          ? evidenceManager.latestTerminalGate0Attempt(task.id)
          : null;
        if (terminalEvidence) {
          evidenceManager.save(terminalEvidence);
          evidence = terminalEvidence;
          attempt = terminalEvidence.gate_0_attempt;
        }
        const classification = classifyGate0Attempt(evidence, task.status, isActive, 5 * 60 * 1000);
        if (!evidence || !attempt || !classification || classification === "active" || classification === "live") continue;
        const requiresPostTaskGates = config.gates.custom_gates.some(
          (gate) => gate.position === "post_task",
        );
        const postTaskEvidence = evidenceManager.load("custom_post_task", task.id);
        if (
          classification === "terminal_passed" &&
          requiresPostTaskGates &&
          postTaskEvidence?.passed !== true
        ) {
          outcomes.push({
            taskId: task.id,
            taskName: task.name,
            classification: "post_task_unproven",
            outcome: attempt.outcome,
          });
          task.gate_0 = {
            passed: false,
            evidence_path: task.gate_0.evidence_path ?? evidenceManager.pathFor("gate_0", task.id),
          };
          stateManager.save(state);
          stateManager.transition(task.id, "failed");
          continue;
        }
        outcomes.push({
          taskId: task.id,
          taskName: task.name,
          classification,
          outcome: attempt.outcome,
        });
        if (classification === "inconsistent") continue;

        if (classification === "interrupted" || classification === "stale") {
          const finishedAt = new Date().toISOString();
          const evidencePath = evidenceManager.saveTerminalGate0Attempt({
            ...evidence,
            passed: false,
            timestamp: finishedAt,
            checks: [
              ...evidence.checks,
              {
                name: "gate_0",
                passed: false,
                detail: "Gate 0 attempt was interrupted before completion. Retry the task to run checks again.",
              },
            ],
            gate_0_attempt: {
              ...attempt,
              finished_at: finishedAt,
              outcome: "interrupted",
              current_check: undefined,
            },
          });
          task.gate_0 = { passed: false, evidence_path: evidencePath };
          stateManager.save(state);
          stateManager.transition(task.id, "failed");
          continue;
        }

        task.gate_0 = {
          passed: evidence.passed,
          evidence_path: task.gate_0.evidence_path ?? evidenceManager.pathFor("gate_0", task.id),
        };
        stateManager.save(state);
        stateManager.transition(task.id, classification === "terminal_passed" ? "done" : "failed");
      }
    }
  }

  return outcomes;
}

// ---------------------------------------------------------------------------
// cycle_diagnose handler
// ---------------------------------------------------------------------------

export async function handleCycleDiagnose(
  stateManager: StateManager,
  evidenceManager: EvidenceManager,
  projectRoot: string,
  config: RigorConfig = DEFAULTS,
): Promise<CallToolResult> {
  const stateBeforeDiagnosis = stateManager.load();
  const requiresReconciliation = stateBeforeDiagnosis?.phases.some((phase) =>
    phase.epics.some((epic) => epic.tasks.some((task) => {
      if (task.status !== "doing") return false;
      const attempt = evidenceManager.load("gate_0", task.id)?.gate_0_attempt;
      return Boolean(attempt && !isGate0AttemptActive(projectRoot, task.id, attempt.id));
    }))) ?? false;
  const recoveryOutcomes = requiresReconciliation
    ? await withProjectMutationLock(projectRoot, async () =>
        reconcilePersistedGate0Attempts(stateManager, evidenceManager, projectRoot, config))
    : [];
  const recoveredTaskIds = new Set(recoveryOutcomes.map((outcome) => outcome.taskId));
  const terminalEvidenceMismatches = terminalGate0Mismatches(stateManager, evidenceManager)
    .filter((mismatch) => !recoveredTaskIds.has(mismatch.taskId));

  // 1. Load state
  const state = stateManager.load();
  if (state === null) {
    return textResult("No active cycle.");
  }

  // 2. Run validation
  const validation = validateState(state, projectRoot);

  // 3. Detect stuck entities, excluding tasks with a live Gate 0 attempt.
  const liveAttempts: { id: string; name: string; check: string; elapsedMs: number; timeoutMs?: number; evidencePath: string }[] = [];
  const liveTaskIds = new Set<string>();
  for (const phase of state.phases) {
    for (const epic of phase.epics) {
      for (const task of epic.tasks) {
        if (task.status !== "doing") continue;
        const evidence = evidenceManager.load("gate_0", task.id);
        const attempt = evidence?.gate_0_attempt;
        if (
          !attempt ||
          attempt.finished_at ||
          !attempt.current_check ||
          !isGate0AttemptActive(projectRoot, task.id, attempt.id)
        ) continue;
        liveTaskIds.add(task.id);
        liveAttempts.push({
          id: task.id,
          name: task.name,
          check: attempt.current_check.check_name,
          elapsedMs: Date.now() - Date.parse(attempt.current_check.started_at),
          timeoutMs: attempt.current_check.configured_timeout_ms,
          evidencePath: join(projectRoot, ".rigor", "evidence", `gate_0-task-${task.id}.json`),
        });
      }
    }
  }
  const stuck = detectStuckEntities(state).filter(
    (entity) => entity.type !== "task" || !liveTaskIds.has(entity.id),
  );

  // 4. Audit evidence completeness
  const missingEvidence: { message: string; entityType: "task" | "epic"; entityId: string; gate: string }[] = [];

  for (const phase of state.phases) {
    for (const epic of phase.epics) {
      // Done tasks should have gate_0 evidence
      for (const task of epic.tasks) {
        if (task.status === "done") {
          const evidence = evidenceManager.load("gate_0", task.id);
          if (evidence === null) {
            missingEvidence.push({
              message: `Task ${task.id}: missing gate_0 evidence`,
              entityType: "task",
              entityId: task.id,
              gate: "gate_0",
            });
          }
        }
      }

      // Done epics should have gate_8 and gate_9 evidence
      if (epic.status === "done") {
        const gate8 = evidenceManager.load("gate_8", epic.id);
        if (gate8 === null) {
          missingEvidence.push({
            message: `Epic ${epic.id}: missing gate_8 evidence`,
            entityType: "epic",
            entityId: epic.id,
            gate: "gate_8",
          });
        }
        const gate9 = evidenceManager.load("gate_9", epic.id);
        if (gate9 === null) {
          missingEvidence.push({
            message: `Epic ${epic.id}: missing gate_9 evidence`,
            entityType: "epic",
            entityId: epic.id,
            gate: "gate_9",
          });
        }
      }
    }
  }

  // 5. Collect failed tasks
  const failedTasks: { id: string; name: string }[] = [];
  for (const phase of state.phases) {
    for (const epic of phase.epics) {
      for (const task of epic.tasks) {
        if (task.status === "failed") {
          failedTasks.push({ id: task.id, name: task.name });
        }
      }
    }
  }

  const attemptHistory = state.phases.flatMap((phase) =>
    phase.epics.flatMap((epic) => epic.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      ...evidenceManager.taskEvidenceSummary(task.id),
    }))),
  ).filter((task) => task.latest || task.prior.length > 0);

  // 6. Determine health status
  let health: "healthy" | "degraded" | "corrupt";
  if (validation.errors.length > 0) {
    health = "corrupt";
  } else if (
    validation.warnings.length > 0 ||
    stuck.length > 0 ||
    missingEvidence.length > 0 ||
    failedTasks.length > 0
  ) {
    health = "degraded";
  } else {
    health = "healthy";
  }

  // 7. Compute progress (exclude skipped entities from totals)
  let tasksDone = 0;
  let tasksActive = 0;
  let epicsDone = 0;
  let epicsActive = 0;

  for (const phase of state.phases) {
    for (const epic of phase.epics) {
      if (epic.status !== "skipped") {
        epicsActive++;
        if (epic.status === "done") {
          epicsDone++;
        }
      }
      for (const task of epic.tasks) {
        if (task.status !== "skipped") {
          tasksActive++;
          if (task.status === "done") {
            tasksDone++;
          }
        }
      }
    }
  }

  // 8. Build report
  const lines: string[] = [];

  lines.push(`Health: ${health}`);
  lines.push(`Cycle: ${state.cycle_id}`);
  lines.push(`Current phase: ${state.current_phase}`);
  lines.push(`Progress: ${tasksDone}/${tasksActive} tasks, ${epicsDone}/${epicsActive} epics`);

  if (liveAttempts.length > 0) {
    lines.push("");
    lines.push("Executing Gate 0 attempts:");
    for (const attempt of liveAttempts) {
      const timeout = attempt.timeoutMs === undefined ? "none" : `${attempt.timeoutMs}ms`;
      lines.push(`  task ${attempt.id} (${attempt.name}): ${attempt.check} (${attempt.elapsedMs}ms elapsed, timeout: ${timeout})`);
      lines.push(`    Evidence: ${attempt.evidencePath}`);
    }
  }

  if (attemptHistory.length > 0) {
    lines.push("");
    lines.push("Gate 0 attempt history:");
    for (const task of attemptHistory) {
      const latest = task.latest ?? "none";
      const prior = task.prior.length === 0 ? "none" : task.prior.join(", ");
      lines.push(`  task ${task.id} (${task.name}): latest ${latest}; prior ${prior}`);
    }
  }

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

  if (recoveryOutcomes.length > 0) {
    lines.push("");
    lines.push("Recovery:");
    for (const recovery of recoveryOutcomes) {
      lines.push(`  task ${recovery.taskId} (${recovery.taskName}): ${recovery.classification}`);
      if (
        recovery.classification === "interrupted" ||
        recovery.classification === "stale" ||
        recovery.classification === "terminal_failed" ||
        recovery.classification === "post_task_unproven"
      ) {
        lines.push(`    Suggestion: task_manage({ task_id: "${recovery.taskId}", action: "retry", confirm: true })`);
      } else if (recovery.classification === "terminal_passed") {
        lines.push("    Reconciled to done; no action required.");
      } else {
        lines.push(`    Suggestion: task_manage({ task_id: "${recovery.taskId}", action: "reset_evidence", confirm: true })`);
      }
    }
  }

  if (terminalEvidenceMismatches.length > 0) {
    lines.push("");
    lines.push("Terminal Gate 0 evidence mismatches:");
    for (const mismatch of terminalEvidenceMismatches) {
      lines.push(`  task ${mismatch.taskId} (${mismatch.taskName}): ${mismatch.outcome ?? "unknown"} evidence conflicts with task status`);
      lines.push(`    Suggestion: task_manage({ task_id: "${mismatch.taskId}", action: "reset_evidence", confirm: true })`);
    }
  }

  // Stuck entities with actionable suggestions
  if (stuck.length > 0) {
    lines.push("");
    lines.push("Stuck entities:");
    for (const s of stuck) {
      lines.push(`  ${s.type} ${s.id} (${s.name}):`);
      if (s.type === "task") {
        lines.push(`    Suggestion: task_manage({ task_id: "${s.id}", action: "force_status", target_status: "failed", confirm: true })`);
        lines.push(`    Suggestion: task_manage({ task_id: "${s.id}", action: "retry", confirm: true })`);
      } else if (s.type === "epic") {
        lines.push(`    Suggestion: epic_manage({ epic_id: "${s.id}", action: "force_status", target_status: "pending", cascade: false, confirm: true })`);
      } else {
        lines.push(`    Suggestion: phase_manage({ phase_id: "${s.id}", action: "force_status", target_status: "pending", confirm: true })`);
      }
    }
  }

  // Failed tasks with retry suggestions
  const unrecoveredFailedTasks = failedTasks.filter((task) => !recoveredTaskIds.has(task.id));
  if (unrecoveredFailedTasks.length > 0) {
    lines.push("");
    lines.push("Failed tasks:");
    for (const t of unrecoveredFailedTasks) {
      lines.push(`  task ${t.id} (${t.name}):`);
      lines.push(`    Suggestion: task_manage({ task_id: "${t.id}", action: "retry", confirm: true })`);
    }
  }

  const evidenceAudit = evidenceManager.audit();
  lines.push("");
  lines.push(`Evidence audit: ${JSON.stringify(evidenceAudit)}`);
  if (missingEvidence.length > 0) {
    lines.push("");
    lines.push(`Evidence audit: ${missingEvidence.length} missing`);
    for (const m of missingEvidence) {
      lines.push(`  ${m.message}`);
      if (m.entityType === "task") {
        lines.push(`    Suggestion: task_manage({ task_id: "${m.entityId}", action: "reset_evidence", confirm: true })`);
      }
    }
  }

  return textResult(lines.join("\n"));
}

