/**
 * Recovery MCP tools: cycle_reset, task_retry, cycle_diagnose.
 *
 * cycle_reset   — previews or destroys the current cycle state + evidence.
 * task_retry    — clears gate_0 evidence for a failed task so it can restart.
 * cycle_diagnose — runs validation, detects stuck entities, audits evidence.
 */

import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { StateManager } from "../state/index.js";
import { EntityNotFoundError, validateState, detectStuckEntities } from "../state/index.js";
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
    "task_retry",
    "Clear gate_0 evidence for a failed task so it can be restarted",
    { task_id: z.string().describe("Task id (e.g. 1.1.1)") },
    async (params) => {
      return handleTaskRetry(params, stateManager, evidenceManager, projectRoot);
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
