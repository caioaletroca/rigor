/**
 * Gate 0 MCP tools: task_start and task_complete.
 *
 * task_start  — validates entry criteria, transitions a task to "doing".
 * task_complete — runs Gate 0 exit checks, saves evidence, transitions
 *                 the task to "done" or "failed".
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { StateManager } from "../state/index.js";
import { EntityNotFoundError } from "../state/index.js";
import type { RigorConfig } from "../config/index.js";
import { EvidenceManager } from "../evidence/index.js";
import type { GateEvidence } from "../evidence/index.js";
import { checkGate0Exit } from "../gates/index.js";
import { runCommand } from "../executor/index.js";

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
// task_start handler
// ---------------------------------------------------------------------------

export interface TaskStartParams {
  task_id: string;
}

export function handleTaskStart(
  params: TaskStartParams,
  stateManager: StateManager,
  projectRoot: string,
): CallToolResult {
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

  // 3. Entry criteria: task must be pending or failed
  if (task.status !== "pending" && task.status !== "failed") {
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
  const gitResult = runCommand("git status --porcelain", { cwd: projectRoot });
  if (gitResult.exit_code === 0 && gitResult.stdout.trim() !== "") {
    warnings.push(
      "Warning: working tree has uncommitted changes.",
    );
  }

  // 6. Transition to "doing"
  stateManager.transition(params.task_id, "doing");

  const lines: string[] = [];
  lines.push(`Task ${params.task_id} started: ${task.name}`);
  lines.push(`Status: doing`);
  if (warnings.length > 0) {
    lines.push("");
    lines.push(warnings.join("\n"));
  }

  return textResult(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// task_complete handler
// ---------------------------------------------------------------------------

export interface TaskCompleteParams {
  task_id: string;
}

export async function handleTaskComplete(
  params: TaskCompleteParams,
  stateManager: StateManager,
  config: RigorConfig,
  projectRoot: string,
): Promise<CallToolResult> {
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

  if (task.status !== "doing") {
    return textResult(
      `Task "${params.task_id}" is in "${task.status}" status. ` +
        `Only "doing" tasks can be completed.`,
      true,
    );
  }

  // 3. Run Gate 0 exit checks
  const gate0Result = await checkGate0Exit(params.task_id, config, projectRoot);

  // 4. Save evidence
  const evidenceManager = new EvidenceManager(projectRoot);
  const evidence: GateEvidence = {
    gate: "gate_0",
    entity_id: params.task_id,
    passed: gate0Result.passed,
    timestamp: new Date().toISOString(),
    checks: gate0Result.checks,
  };
  const evidencePath = evidenceManager.save(evidence);

  // 5. Update task gate_0 field in state
  const freshState = stateManager.load();
  if (freshState !== null) {
    for (const phase of freshState.phases) {
      for (const epic of phase.epics) {
        for (const t of epic.tasks) {
          if (t.id === params.task_id) {
            t.gate_0 = {
              passed: gate0Result.passed,
              evidence_path: evidencePath,
              coverage: gate0Result.coverage,
              lint_passed: gate0Result.checks.find((c) => c.name === "lint")
                ?.passed,
              tests_passed: gate0Result.checks.find((c) => c.name === "tests")
                ?.passed,
            };
          }
        }
      }
    }
    stateManager.save(freshState);
  }

  // 6. Transition based on result
  if (gate0Result.passed) {
    stateManager.transition(params.task_id, "done");
  } else {
    stateManager.transition(params.task_id, "failed");
  }

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
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerGateTools(
  server: McpServer,
  stateManager: StateManager,
  config: RigorConfig,
  projectRoot: string,
): void {
  server.tool(
    "task_start",
    "Begin work on a task — validates entry criteria, transitions to doing",
    { task_id: z.string().describe("Task id (e.g. 1.1.1)") },
    async (params) => {
      return handleTaskStart(params, stateManager, projectRoot);
    },
  );

  server.tool(
    "task_complete",
    "Complete a task — runs Gate 0 exit checks (tests, coverage, lint), saves evidence",
    { task_id: z.string().describe("Task id (e.g. 1.1.1)") },
    async (params) => {
      return handleTaskComplete(params, stateManager, config, projectRoot);
    },
  );
}
