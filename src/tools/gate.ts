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
import {
  checkGate0Exit,
  checkGate1Exit,
  checkGate2Exit,
  checkGate3Exit,
  checkGate4Exit,
  checkGate5Exit,
  runCustomGates,
} from "../gates/index.js";
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
  config: RigorConfig,
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

  // 5b. Run pre_task custom gates
  const customResult = runCustomGates("pre_task", params.task_id, config, projectRoot);
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
  const gate1Result = checkGate1Exit(config, projectRoot);
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

  // 5b. Run post_task custom gates (only if Gate 0 passed)
  if (gate0Result.passed) {
    const customResult = runCustomGates("post_task", params.task_id, config, projectRoot);
    if (!customResult.passed) {
      // Save custom gate evidence
      const customEvidence: GateEvidence = {
        gate: "custom_post_task",
        entity_id: params.task_id,
        passed: false,
        timestamp: new Date().toISOString(),
        checks: customResult.checks,
      };
      evidenceManager.save(customEvidence);

      // Gate 0 passed but post_task custom gate failed → task fails
      stateManager.transition(params.task_id, "failed");

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
      return textResult(lines.join("\n"), true);
    }
  }

  // 5c. Run frontend gates 2-5 (conditional, after Gate 0 passes)
  const frontendWarnings: string[] = [];

  if (gate0Result.passed) {
    // Gate 2: Accessibility
    const gate2Result = checkGate2Exit(config, projectRoot);
    if (!gate2Result.skipped) {
      const gate2Evidence: GateEvidence = {
        gate: "gate_2",
        entity_id: params.task_id,
        passed: gate2Result.passed,
        timestamp: new Date().toISOString(),
        checks: gate2Result.checks,
      };
      evidenceManager.save(gate2Evidence);

      if (!gate2Result.passed) {
        if (config.gates.gate_2.required) {
          stateManager.transition(params.task_id, "failed");

          const lines: string[] = [];
          lines.push(`Task ${params.task_id} failed Gate 2 (accessibility).`);
          lines.push("");
          for (const check of gate2Result.checks) {
            const icon = check.passed ? "PASS" : "FAIL";
            lines.push(`  [${icon}] ${check.name}: ${check.detail}`);
          }
          return textResult(lines.join("\n"), true);
        }
        frontendWarnings.push(
          `Gate 2 (accessibility): WARN — ${gate2Result.checks.filter((c) => !c.passed).map((c) => c.detail).join("; ")}`,
        );
      }
    }

    // Gate 3: Visual Regression
    const gate3Result = checkGate3Exit(config, projectRoot);
    if (!gate3Result.skipped) {
      const gate3Evidence: GateEvidence = {
        gate: "gate_3",
        entity_id: params.task_id,
        passed: gate3Result.passed,
        timestamp: new Date().toISOString(),
        checks: gate3Result.checks,
      };
      evidenceManager.save(gate3Evidence);

      if (!gate3Result.passed) {
        if (config.gates.gate_3.required) {
          stateManager.transition(params.task_id, "failed");

          const lines: string[] = [];
          lines.push(`Task ${params.task_id} failed Gate 3 (visual regression).`);
          lines.push("");
          for (const check of gate3Result.checks) {
            const icon = check.passed ? "PASS" : "FAIL";
            lines.push(`  [${icon}] ${check.name}: ${check.detail}`);
          }
          return textResult(lines.join("\n"), true);
        }
        frontendWarnings.push(
          `Gate 3 (visual regression): WARN — ${gate3Result.checks.filter((c) => !c.passed).map((c) => c.detail).join("; ")}`,
        );
      }
    }

    // Gate 4: E2E
    const gate4Result = checkGate4Exit(config, projectRoot);
    if (!gate4Result.skipped) {
      const gate4Evidence: GateEvidence = {
        gate: "gate_4",
        entity_id: params.task_id,
        passed: gate4Result.passed,
        timestamp: new Date().toISOString(),
        checks: gate4Result.checks,
      };
      evidenceManager.save(gate4Evidence);

      if (!gate4Result.passed) {
        if (config.gates.gate_4.required) {
          stateManager.transition(params.task_id, "failed");

          const lines: string[] = [];
          lines.push(`Task ${params.task_id} failed Gate 4 (e2e tests).`);
          lines.push("");
          for (const check of gate4Result.checks) {
            const icon = check.passed ? "PASS" : "FAIL";
            lines.push(`  [${icon}] ${check.name}: ${check.detail}`);
          }
          return textResult(lines.join("\n"), true);
        }
        frontendWarnings.push(
          `Gate 4 (e2e): WARN — ${gate4Result.checks.filter((c) => !c.passed).map((c) => c.detail).join("; ")}`,
        );
      }
    }

    // Gate 5: Performance
    const gate5Result = checkGate5Exit(config, projectRoot);
    if (!gate5Result.skipped) {
      const gate5Evidence: GateEvidence = {
        gate: "gate_5",
        entity_id: params.task_id,
        passed: gate5Result.passed,
        timestamp: new Date().toISOString(),
        checks: gate5Result.checks,
      };
      evidenceManager.save(gate5Evidence);

      if (!gate5Result.passed) {
        if (config.gates.gate_5.required) {
          stateManager.transition(params.task_id, "failed");

          const lines: string[] = [];
          lines.push(`Task ${params.task_id} failed Gate 5 (performance).`);
          lines.push("");
          for (const check of gate5Result.checks) {
            const icon = check.passed ? "PASS" : "FAIL";
            lines.push(`  [${icon}] ${check.name}: ${check.detail}`);
          }
          return textResult(lines.join("\n"), true);
        }
        frontendWarnings.push(
          `Gate 5 (performance): WARN — ${gate5Result.checks.filter((c) => !c.passed).map((c) => c.detail).join("; ")}`,
        );
      }
    }
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

  if (frontendWarnings.length > 0) {
    lines.push("");
    lines.push("Frontend gate warnings:");
    for (const warning of frontendWarnings) {
      lines.push(`  ${warning}`);
    }
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
      return handleTaskStart(params, stateManager, config, projectRoot);
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
