/**
 * Gate 0 MCP tools: task_start and task_complete.
 *
 * task_start  — validates entry criteria, transitions a task to "doing".
 * task_complete — runs Gate 0 exit checks, saves evidence, transitions
 *                 the task to "done" or "failed".
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { responseResult } from "../tools/lifecycle.js";
import type { StateManager, TaskLease, LeaseFenceMismatchReason } from "../state/index.js";
import { EntityNotFoundError, isValidTransition, TASK_LEASE_DURATION_MS } from "../state/index.js";
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
    `Task ${taskId} attempt is stale and its result was not promoted. The attempt history was retained; retry with the current lease.`,
    true,
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
  const gate0Readiness = evaluateGate0Readiness(cfg);
  if (!gate0Readiness.ready) {
    return textResult(`Task ${params.task_id} blocked: ${gate0Readiness.detail}`, true);
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
    lease_expires_at: new Date(Date.now() + (params.lease_ms ?? TASK_LEASE_DURATION_MS)).toISOString(),
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
// task_renew handler
// ---------------------------------------------------------------------------

export interface TaskRenewParams {
  task_id: string;
  owner_id: string;
  attempt_id: string;
  project_root?: string;
}

const LEASE_RENEWAL_REASONS: Record<LeaseFenceMismatchReason, string> = {
  status_changed: "its persisted status is no longer \"doing\"",
  owner_changed: "its lease is held by a different owner",
  attempt_changed: "its lease was reissued to a different attempt",
  lease_expired: "its lease already expired",
  malformed_timestamp: "its persisted lease is missing or malformed",
};

export async function handleTaskRenew(
  params: TaskRenewParams,
  stateManager: StateManager,
  projectRoot: string,
): Promise<CallToolResult> {
  if (stateManager.load() === null) {
    return textResult("No active cycle. Run cycle_init first.", true);
  }

  return withProjectMutationLock(projectRoot, async () => {
    let renewal;
    try {
      renewal = stateManager.renewPersistedLease({
        task_id: params.task_id,
        owner_id: params.owner_id,
        attempt_id: params.attempt_id,
      });
    } catch (error: unknown) {
      if (error instanceof EntityNotFoundError) {
        return textResult(`Task "${params.task_id}" not found.`, true);
      }
      throw error;
    }

    if (!renewal.ok) {
      return textResult(
        `Task "${params.task_id}" lease was not renewed for owner "${params.owner_id}" attempt "${params.attempt_id}" because ${LEASE_RENEWAL_REASONS[renewal.reason]}. ` +
          `Canonical state was not modified; call task_start({ task_id: "${params.task_id}", owner_id: "<replacement-owner>", takeover: true }) to obtain a new lease.`,
        true,
      );
    }

    return textResult(
      [
        `Task ${params.task_id} lease renewed for owner ${params.owner_id}.`,
        `Attempt: ${params.attempt_id}`,
        `Lease expires at: ${renewal.lease.lease_expires_at}`,
      ].join("\n"),
    );
  });
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
  if ((legacyCompletion && task.lease) || (!legacyCompletion && (params.owner_id === undefined || params.attempt_id === undefined || !task.lease || task.lease.owner_id !== params.owner_id || task.lease.attempt_id !== params.attempt_id))) {
    return textResult(`Task "${params.task_id}" is not owned by owner "${(params.owner_id ?? "legacy")}" with attempt "${(params.attempt_id ?? task.lease?.attempt_id ?? "legacy")}".`, true);
  }
  if (task.lease && !Number.isFinite(Date.parse(task.lease.lease_expires_at))) {
    return textResult(`Task "${params.task_id}" has an invalid lease expiration timestamp.`, true);
  }
  if (task.lease && Date.parse(task.lease.lease_expires_at) <= Date.now() && !legacyCompletion) {
    return textResult(`Task "${params.task_id}" lease expired at ${task.lease.lease_expires_at}. Call task_start({ task_id: "${params.task_id}", owner_id: "${params.owner_id}", takeover: true }) to obtain a fresh attempt.`, true);
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
    const inProgressCommit = await withProjectMutationLock(projectRoot, async () => {
      const fence = legacyCompletion
        ? stateManager.assertPersistedLegacyLease(params.task_id)
        : stateManager.assertPersistedLease({ task_id: params.task_id, owner_id: params.owner_id!, attempt_id: attemptId });
      if (!fence.ok) return false;
      const inProgressEvidencePath = evidenceManager.save(inProgressEvidence);
      fence.task.gate_0 = { ...fence.task.gate_0, evidence_path: inProgressEvidencePath };
      stateManager.save(fence.state);
      return true;
    });
    if (!inProgressCommit) return staleAttemptResult(params.task_id);

    let gate0Result;
    let executionError: string | undefined;
    try {
      gate0Result = await checkGate0Exit(params.task_id, cfg, projectRoot, {
        onCheckStart: async (progress) => {
          const promoted = await withProjectMutationLock(projectRoot, async () => {
            const fence = legacyCompletion
              ? stateManager.assertPersistedLegacyLease(params.task_id)
              : stateManager.assertPersistedLease({ task_id: params.task_id, owner_id: params.owner_id!, attempt_id: attemptId });
            if (!fence.ok) return false;
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
      gate_0_attempt: { version: 1, id: attemptId, owner_id: params.owner_id ?? "legacy", started_at: startedAt, finished_at: finishedAt, outcome },
    };
    evidenceManager.saveGate0AttemptHistory(terminalEvidence);
    const terminalCommit = await withProjectMutationLock(projectRoot, async () => {
      const fence = legacyCompletion
        ? stateManager.assertPersistedLegacyLease(params.task_id)
        : stateManager.assertPersistedLease({ task_id: params.task_id, owner_id: params.owner_id!, attempt_id: attemptId });
      if (!fence.ok) return false;
      const evidencePath = evidenceManager.promoteTerminalGate0Attempt(terminalEvidence);
      fence.task.gate_0 = {
        passed: gate0Result.passed,
        evidence_path: evidencePath,
        coverage: gate0Result.coverage,
        lint_passed: gate0Result.checks.find((check) => check.name === "lint")?.passed,
        tests_passed: gate0Result.checks.find((check) => check.name === "tests")?.passed,
      };
      stateManager.save(fence.state);
      return evidencePath;
    });
    if (!terminalCommit) return staleAttemptResult(params.task_id);
    const evidencePath = terminalCommit;
    if (executionError) {
      const failed = await withProjectMutationLock(projectRoot, async () => {
        const fence = legacyCompletion ? stateManager.assertPersistedLegacyLease(params.task_id) : stateManager.assertPersistedLease({ task_id: params.task_id, owner_id: params.owner_id!, attempt_id: attemptId });
        if (!fence.ok) return false;
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
        const fence = legacyCompletion ? stateManager.assertPersistedLegacyLease(params.task_id) : stateManager.assertPersistedLease({ task_id: params.task_id, owner_id: params.owner_id!, attempt_id: attemptId });
        if (!fence.ok) return false;
        evidenceManager.save({ gate: "custom_post_task", entity_id: params.task_id, passed: false, timestamp: new Date().toISOString(), checks: customResult.checks });
        fence.task.gate_0 = { passed: false, evidence_path: evidencePath };
        stateManager.save(fence.state);
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
    const fence = legacyCompletion ? stateManager.assertPersistedLegacyLease(params.task_id) : stateManager.assertPersistedLease({ task_id: params.task_id, owner_id: params.owner_id!, attempt_id: attemptId });
    if (!fence.ok) return false;
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
      const fence = legacyCompletion ? stateManager.assertPersistedLegacyLease(params.task_id) : stateManager.assertPersistedLease({ task_id: params.task_id, owner_id: params.owner_id!, attempt_id: attemptId });
      if (!fence.ok) return false;
      stateManager.transition(params.task_id, "failed");
      return true;
    });
    if (!failed) return staleAttemptResult(params.task_id);
    return textResult(`Task ${params.task_id} failed while initializing or persisting its Gate 0 attempt. The active attempt was cleared and the task can be retried.\n\n  [FAIL] gate_0: ${detail}`, true);
  } finally {
    activeTaskCompletions.delete(key);
  }
}

