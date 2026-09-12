/**
 * Gate 0 MCP tools: task_start and task_complete.
 *
 * task_start  — validates entry criteria, transitions a task to "doing".
 * task_complete — runs Gate 0 exit checks, saves evidence, transitions
 *                 the task to "done" or "failed".
 */

import { isAbsolute } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { StateManager, TaskLease } from "../state/index.js";
import { EntityNotFoundError, isValidTransition } from "../state/index.js";
import type { RigorConfig } from "../config/index.js";
import { loadConfig } from "../config/index.js";
import { EvidenceManager } from "../evidence/index.js";
import type { GateEvidence } from "../evidence/index.js";
import {
  checkGate0Exit,
  checkGate1Exit,
  runCustomGates,
} from "../gates/index.js";
import { runCommand } from "../executor/index.js";
import type { ProjectContextRegistry } from "../context.js";
import { withProjectMutationLock } from "../lifecycle/index.js";

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function textResult(text: string, isError?: boolean): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
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
  takeover?: boolean;
  lease_ms?: number;
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

  const now = Date.now();
  const leaseTimestamp = task.lease ? Date.parse(task.lease.lease_expires_at) : undefined;
  if (task.lease && !Number.isFinite(leaseTimestamp)) {
    return textResult(`Task "${params.task_id}" has an invalid lease expiration timestamp.`, true);
  }
  const activeLease = task.lease && leaseTimestamp! > now;
  if (activeLease && task.lease!.owner_id !== (params.owner_id ?? "legacy")) {
    return textResult(`Task "${params.task_id}" is owned by "${task.lease!.owner_id}" until ${task.lease!.lease_expires_at}.`, true);
  }

  const expiredTakeover = Boolean(params.takeover && task.status === "doing" && task.lease && !activeLease);
  if (task.status !== "pending" && task.status !== "failed" && !expiredTakeover) {
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

  // 6. Transition to "doing" and issue the lease in one persisted state update
  const attemptId = crypto.randomUUID();
  const lease: TaskLease = {
    owner_id: (params.owner_id ?? "legacy"),
    attempt_id: attemptId,
    lease_expires_at: new Date(Date.now() + (params.lease_ms ?? 300000)).toISOString(),
    ...(task.lease && !activeLease ? { takeover_history: [...(task.lease.takeover_history ?? []), { ...task.lease, taken_over_at: new Date().toISOString() }] } : {}),
  };
  const commitResult = await withProjectMutationLock(projectRoot, async () => {
    const leasedState = stateManager.load();
    if (!leasedState) return textResult("No active cycle. Run cycle_init first.", true);
    for (const phase of leasedState.phases) for (const epic of phase.epics) for (const currentTask of epic.tasks) {
      if (currentTask.id === params.task_id) {
        const currentLeaseExpiresAt = currentTask.lease
          ? Date.parse(currentTask.lease.lease_expires_at)
          : undefined;
        const transitionAllowed = expiredTakeover
          ? currentTask.status === "doing" &&
            Number.isFinite(currentLeaseExpiresAt) &&
            currentLeaseExpiresAt! <= Date.now()
          : isValidTransition(currentTask.status, "doing");
        if (!transitionAllowed) {
          if (currentTask.lease && Date.parse(currentTask.lease.lease_expires_at) > Date.now()) {
            return textResult(`Task "${params.task_id}" is owned by "${currentTask.lease.owner_id}" until ${currentTask.lease.lease_expires_at}.`, true);
          }
          return textResult(`Task "${params.task_id}" changed before its lease could be issued.`, true);
        }
        currentTask.status = "doing";
        currentTask.lease = lease;
      }
    }
    stateManager.save(leasedState);
    return null;
  });
  if (commitResult) return commitResult;

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
  owner_id?: string;
  attempt_id?: string;
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

  const legacyCompletion = params.owner_id === undefined && params.attempt_id === undefined;
  if (
    (legacyCompletion && task.lease) ||
    (!legacyCompletion && (params.owner_id === undefined || params.attempt_id === undefined || !task.lease || task.lease.owner_id !== params.owner_id || task.lease.attempt_id !== params.attempt_id))
  ) {
    return textResult(`Task "${params.task_id}" is not owned by owner "${(params.owner_id ?? "legacy")}" with attempt "${(params.attempt_id ?? task.lease?.attempt_id ?? "legacy")}".`, true);
  }
  if (task.lease && !Number.isFinite(Date.parse(task.lease.lease_expires_at))) {
    return textResult(`Task "${params.task_id}" has an invalid lease expiration timestamp.`, true);
  }
  if (task.lease && Date.parse(task.lease.lease_expires_at) <= Date.now()) {
    return textResult(`Task "${params.task_id}" lease expired at ${task.lease.lease_expires_at}. Start it with explicit takeover.`, true);
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
    const attemptId = params.attempt_id ?? task.lease?.attempt_id ?? crypto.randomUUID();
    activeTaskCompletions.set(key, attemptId);
  try {
    const inProgressEvidence: GateEvidence = {
      gate: "gate_0",
      entity_id: params.task_id,
      passed: false,
      timestamp: startedAt,
      checks: [],
      gate_0_attempt: { version: 1, id: attemptId,
             owner_id: (params.owner_id ?? "legacy"),
             started_at: startedAt },
    };
    const inProgressEvidencePath = evidenceManager.save(inProgressEvidence);
    const inProgressState = stateManager.load();
    if (inProgressState !== null) {
      for (const phase of inProgressState.phases) {
        for (const epic of phase.epics) {
          for (const inProgressTask of epic.tasks) {
            if (inProgressTask.id === params.task_id) {
              inProgressTask.gate_0 = {
                ...inProgressTask.gate_0,
                evidence_path: inProgressEvidencePath,
              };
            }
          }
        }
      }
      stateManager.save(inProgressState);
    }

    let gate0Result;
    let evidencePath: string;
    try {
      gate0Result = await checkGate0Exit(params.task_id, cfg, projectRoot, {
        onCheckStart: (progress) => {
          evidenceManager.save({
            ...inProgressEvidence,
            gate_0_attempt: {
              version: 1,
              id: attemptId,
              started_at: startedAt,
              current_check: {
                ...progress,
                started_at: new Date().toISOString(),
              },
            },
          });
        },
      });
    const outcome = gate0Result.passed
      ? "passed"
      : gate0Result.checks.some((check) => check.timed_out)
        ? "timed_out"
        : gate0Result.checks.some((check) => check.cancelled)
          ? "cancelled"
          : "failed";
    const finishedAt = new Date().toISOString();
    evidencePath = evidenceManager.saveTerminalGate0Attempt({
      ...inProgressEvidence,
      passed: gate0Result.passed,
      timestamp: finishedAt,
      checks: gate0Result.checks,
      gate_0_attempt: {
        version: 1,
        id: attemptId,
        started_at: startedAt,
        finished_at: finishedAt,
        outcome,
      },
    });
  } catch (error: unknown) {
    const finishedAt = new Date().toISOString();
    const detail = error instanceof Error ? error.message : String(error);
    evidencePath = evidenceManager.saveTerminalGate0Attempt({
      ...inProgressEvidence,
      timestamp: finishedAt,
      checks: [{ name: "gate_0", passed: false, detail: `Gate 0 execution error: ${detail}` }],
      gate_0_attempt: {
        version: 1,
        id: attemptId,
        started_at: startedAt,
        finished_at: finishedAt,
        outcome: "execution_error",
      },
    });
    const failedState = stateManager.load();
    if (failedState !== null) {
      for (const phase of failedState.phases) {
        for (const epic of phase.epics) {
          for (const failedTask of epic.tasks) {
            if (failedTask.id === params.task_id) {
              failedTask.gate_0 = { passed: false, evidence_path: evidencePath };
            }
          }
        }
      }
      stateManager.save(failedState);
    }
    stateManager.transition(params.task_id, "failed");
    return textResult(
      `Task ${params.task_id} failed because Gate 0 could not run.\n\n` +
        `  [FAIL] gate_0: Gate 0 execution error: ${detail}\n\nEvidence: ${evidencePath}`,
      true,
    );
  }

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
    let customResult;
    try {
      customResult = await runCustomGates("post_task", params.task_id, cfg, projectRoot);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      evidenceManager.save({
        gate: "custom_post_task",
        entity_id: params.task_id,
        passed: false,
        timestamp: new Date().toISOString(),
        checks: [{ name: "custom_post_task", passed: false, detail: `Post-task custom gate execution error: ${detail}` }],
      });
      const failedState = stateManager.load();
      if (failedState !== null) {
        for (const phase of failedState.phases) {
          for (const epic of phase.epics) {
            for (const failedTask of epic.tasks) {
              if (failedTask.id === params.task_id) {
                failedTask.gate_0 = { passed: false, evidence_path: evidencePath };
              }
            }
          }
        }
        stateManager.save(failedState);
      }
      stateManager.transition(params.task_id, "failed");
      return textResult(
        `Task ${params.task_id} passed Gate 0 but post_task custom gates could not run.\n\n` +
          `  [FAIL] custom_post_task: Post-task custom gate execution error: ${detail}\n\nEvidence: ${evidencePath}`,
        true,
      );
    }
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
    const failedState = stateManager.load();
    if (failedState !== null) {
      for (const phase of failedState.phases) {
        for (const epic of phase.epics) {
          for (const failedTask of epic.tasks) {
            if (failedTask.id === params.task_id) {
              failedTask.gate_0 = { passed: false, evidence_path: evidencePath };
            }
          }
        }
      }
      stateManager.save(failedState);
    }
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
      activeTaskCompletions.delete(key);
      return textResult(lines.join("\n"), true);
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

  lines.push("");
  lines.push(`Evidence: ${evidencePath}`);

    return textResult(lines.join("\n"), !gate0Result.passed);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      stateManager.transition(params.task_id, "failed");
      return textResult(
        `Task ${params.task_id} failed while initializing or persisting its Gate 0 attempt. ` +
          `The active attempt was cleared and the task can be retried.\n\n` +
          `  [FAIL] gate_0: ${detail}`,
        true,
      );
    } catch (transitionError: unknown) {
      const transitionDetail = transitionError instanceof Error
        ? transitionError.message
        : String(transitionError);
      return textResult(
        `Task ${params.task_id} could not initialize its Gate 0 attempt and could not be transitioned safely. ` +
          `The active attempt was cleared; inspect and recover the task with task_manage.\n\n` +
          `  [FAIL] gate_0: ${detail}\n` +
          `  [FAIL] state recovery: ${transitionDetail}`,
        true,
      );
    }
  } finally {
    activeTaskCompletions.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerGateTools(
  server: McpServer,
  stateManager: StateManager,
  projectRoot: string,
  registry?: ProjectContextRegistry,
): void {
  const context = (root: string) => registry?.getByRoot(root);
  // Handlers receive `null` for config so they reload .rigor/config.yaml fresh
  // per invocation — config edits take effect without a server restart.
  server.tool(
    "task_start",
    "Begin work on a task — validates entry criteria, transitions to doing",
 { task_id: z.string().describe("Task id (e.g. 1.1.1)"), owner_id: z.string().min(1), takeover: z.boolean().optional(), lease_ms: z.number().int().positive().optional(), project_root: z.string().refine(isAbsolute, "project_root must be an absolute path").optional() },
     async (params) => {
       const ctx = context(params.project_root ?? stateManager.load()?.project_root ?? projectRoot);
       return handleTaskStart(params, ctx?.stateManager ?? stateManager, ctx?.config ?? null, ctx?.project_root ?? projectRoot);
    },
  );

  server.tool(
    "task_complete",
    "Complete a task — runs Gate 0 exit checks (tests, coverage, lint), saves evidence",
 { task_id: z.string().describe("Task id (e.g. 1.1.1)"), owner_id: z.string().min(1), attempt_id: z.string().min(1), project_root: z.string().refine(isAbsolute, "project_root must be an absolute path").optional() },
     async (params) => {
       const ctx = context(params.project_root ?? stateManager.load()?.project_root ?? projectRoot);
       return handleTaskComplete(params, ctx?.stateManager ?? stateManager, ctx?.config ?? null, ctx?.project_root ?? projectRoot);
    },
  );
}
