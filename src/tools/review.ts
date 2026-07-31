/**
 * Review & acceptance MCP tools: review_start, review_submit,
 * accept_start, accept_submit, phase_advance.
 *
 * review_start  — verifies all tasks done, starts epic review.
 * review_submit — runs Gate 8 checks, saves evidence.
 * accept_start  — verifies Gate 8 passed, returns criteria.
 * accept_submit — runs Gate 9 checks, saves evidence, transitions epic.
 * phase_advance — advances to the next phase when all epics are done.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { StateManager } from "../state/index.js";
import { EntityNotFoundError } from "../state/index.js";
import type { RigorConfig } from "../config/index.js";
import type { EvidenceManager, GateEvidence } from "../evidence/index.js";
import { checkGate8Exit, checkGate9Exit, runCustomGates } from "../gates/index.js";
import type { ReviewFindings, AcceptanceCriterion } from "../gates/index.js";

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
// review_start handler
// ---------------------------------------------------------------------------

export interface ReviewStartParams {
  epic_id: string;
}

export function handleReviewStart(
  params: ReviewStartParams,
  stateManager: StateManager,
  config: RigorConfig,
  projectRoot: string,
): CallToolResult {
  // 1. Load state, verify cycle exists
  const state = stateManager.load();
  if (state === null) {
    return textResult("No active cycle. Run cycle_init first.", true);
  }

  // 2. Find the epic
  let epic;
  try {
    epic = stateManager.getEpic(params.epic_id);
  } catch (error: unknown) {
    if (error instanceof EntityNotFoundError) {
      return textResult(`Epic "${params.epic_id}" not found.`, true);
    }
    throw error;
  }

  // 2b. An epic with no tasks cannot be reviewed — there is no implemented
  // work to certify. Guards the rolling-wave case where a later-phase epic
  // has not yet been elaborated into tasks.
  if (epic.tasks.length === 0) {
    return textResult(
      `Epic "${params.epic_id}" has no tasks — cannot review an epic with no implemented work. ` +
        `Elaborate its tasks into the plan (and re-init the cycle) before review.`,
      true,
    );
  }

  // 3. Verify ALL tasks in this epic have status "done" and gate_0.passed
  const incompleteTasks: string[] = [];
  for (const task of epic.tasks) {
    if (task.status !== "done" || !task.gate_0.passed) {
      incompleteTasks.push(
        `${task.id} (${task.name}): status=${task.status}, gate_0=${task.gate_0.passed ? "pass" : "fail"}`,
      );
    }
  }

  if (incompleteTasks.length > 0) {
    const lines: string[] = [];
    lines.push(`Cannot start review for epic "${params.epic_id}" — incomplete tasks:`);
    for (const t of incompleteTasks) {
      lines.push(`  - ${t}`);
    }
    return textResult(lines.join("\n"), true);
  }

  // 4. Transition epic to "doing" if still pending
  if (epic.status === "pending") {
    stateManager.transition(params.epic_id, "doing");
  }

  // 4b. Run pre_review custom gates
  const customResult = runCustomGates("pre_review", params.epic_id, config, projectRoot);
  if (!customResult.passed) {
    const lines: string[] = [];
    lines.push(`Epic ${params.epic_id} blocked by custom pre_review gate.`);
    lines.push("");
    for (const check of customResult.checks) {
      const icon = check.passed ? "PASS" : "FAIL";
      lines.push(`  [${icon}] ${check.name}: ${check.detail}`);
    }
    return textResult(lines.join("\n"), true);
  }

  // 5. Return summary
  const reviewers = config.gates.gate_8.reviewers;
  const lines: string[] = [];
  lines.push(`Review started for epic ${params.epic_id}: ${epic.name}`);
  lines.push(`Tasks: ${epic.tasks.length} (all done, all passed Gate 0)`);
  lines.push(`Expected reviewers: ${reviewers.join(", ")}`);

  return textResult(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// review_submit handler
// ---------------------------------------------------------------------------

export interface ReviewSubmitParams {
  epic_id: string;
  submissions: string;
}

export function handleReviewSubmit(
  params: ReviewSubmitParams,
  stateManager: StateManager,
  evidenceManager: EvidenceManager,
  config: RigorConfig,
): CallToolResult {
  // 1. Load state, verify epic is in "doing" status
  const state = stateManager.load();
  if (state === null) {
    return textResult("No active cycle. Run cycle_init first.", true);
  }

  let epic;
  try {
    epic = stateManager.getEpic(params.epic_id);
  } catch (error: unknown) {
    if (error instanceof EntityNotFoundError) {
      return textResult(`Epic "${params.epic_id}" not found.`, true);
    }
    throw error;
  }

  if (epic.status !== "doing") {
    return textResult(
      `Epic "${params.epic_id}" is in "${epic.status}" status. ` +
        `Only "doing" epics can receive review submissions. Run review_start first.`,
      true,
    );
  }

  // 2. Parse submissions JSON
  let submissions: ReviewFindings[];
  try {
    submissions = JSON.parse(params.submissions) as ReviewFindings[];
  } catch {
    return textResult("Invalid submissions JSON.", true);
  }

  // 3. Run Gate 8 checks
  const gate8Result = checkGate8Exit(submissions, config);

  // 4. Save evidence
  const evidence: GateEvidence = {
    gate: "gate_8",
    entity_id: params.epic_id,
    passed: gate8Result.passed,
    timestamp: new Date().toISOString(),
    checks: gate8Result.checks,
  };
  const evidencePath = evidenceManager.save(evidence);

  // 5. Update epic's gate_8 field in state
  const freshState = stateManager.load();
  if (freshState !== null) {
    for (const phase of freshState.phases) {
      for (const e of phase.epics) {
        if (e.id === params.epic_id) {
          e.gate_8 = {
            passed: gate8Result.passed,
            evidence_path: evidencePath,
          };
        }
      }
    }
    stateManager.save(freshState);
  }

  // 6. Build response
  const lines: string[] = [];

  if (gate8Result.passed) {
    lines.push(`Gate 8 PASSED for epic ${params.epic_id}.`);
  } else {
    lines.push(`Gate 8 FAILED for epic ${params.epic_id}.`);
  }

  lines.push("");
  lines.push("Checks:");
  for (const check of gate8Result.checks) {
    const icon = check.passed ? "PASS" : "FAIL";
    lines.push(`  [${icon}] ${check.name}: ${check.detail}`);
  }

  if (gate8Result.missing_reviewers.length > 0) {
    lines.push("");
    lines.push(`Missing reviewers: ${gate8Result.missing_reviewers.join(", ")}`);
  }

  lines.push("");
  lines.push(`Critical findings: ${gate8Result.critical_count}`);
  lines.push(`High findings: ${gate8Result.high_count}`);
  lines.push(`Evidence: ${evidencePath}`);

  return textResult(lines.join("\n"), !gate8Result.passed);
}

// ---------------------------------------------------------------------------
// accept_start handler
// ---------------------------------------------------------------------------

export interface AcceptStartParams {
  epic_id: string;
}

export function handleAcceptStart(
  params: AcceptStartParams,
  stateManager: StateManager,
): CallToolResult {
  // 1. Load state
  const state = stateManager.load();
  if (state === null) {
    return textResult("No active cycle. Run cycle_init first.", true);
  }

  // 2. Find epic
  let epic;
  try {
    epic = stateManager.getEpic(params.epic_id);
  } catch (error: unknown) {
    if (error instanceof EntityNotFoundError) {
      return textResult(`Epic "${params.epic_id}" not found.`, true);
    }
    throw error;
  }

  // 3. Verify gate_8 passed
  if (!epic.gate_8.passed) {
    return textResult(
      `Epic "${params.epic_id}" has not passed Gate 8 (code review). ` +
        `Run review_submit first.`,
      true,
    );
  }

  // 4. Return epic info and done_when criteria
  const lines: string[] = [];
  lines.push(`Acceptance started for epic ${params.epic_id}: ${epic.name}`);
  lines.push(`Gate 8: passed`);
  lines.push("");
  lines.push("Validate the acceptance criteria for this epic and submit via accept_submit.");

  return textResult(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// accept_submit handler
// ---------------------------------------------------------------------------

export interface AcceptSubmitParams {
  epic_id: string;
  criteria: string;
  user_approved: boolean;
}

export function handleAcceptSubmit(
  params: AcceptSubmitParams,
  stateManager: StateManager,
  evidenceManager: EvidenceManager,
  config: RigorConfig,
  projectRoot: string,
): CallToolResult {
  // 1. Load state
  const state = stateManager.load();
  if (state === null) {
    return textResult("No active cycle. Run cycle_init first.", true);
  }

  // 2. Find epic and verify gate_8 passed
  let epic;
  try {
    epic = stateManager.getEpic(params.epic_id);
  } catch (error: unknown) {
    if (error instanceof EntityNotFoundError) {
      return textResult(`Epic "${params.epic_id}" not found.`, true);
    }
    throw error;
  }

  if (!epic.gate_8.passed) {
    return textResult(
      `Epic "${params.epic_id}" has not passed Gate 8 (code review). ` +
        `Run review_submit first.`,
      true,
    );
  }

  // 3. Parse criteria JSON
  let criteria: AcceptanceCriterion[];
  try {
    criteria = JSON.parse(params.criteria) as AcceptanceCriterion[];
  } catch {
    return textResult("Invalid criteria JSON.", true);
  }

  // 4. Run Gate 9 checks
  const gate9Result = checkGate9Exit(criteria, params.user_approved, config);

  // 5. Save evidence
  const evidence: GateEvidence = {
    gate: "gate_9",
    entity_id: params.epic_id,
    passed: gate9Result.passed,
    timestamp: new Date().toISOString(),
    checks: gate9Result.checks,
  };
  const evidencePath = evidenceManager.save(evidence);

  // 6. Update epic's gate_9 field in state
  const freshState = stateManager.load();
  if (freshState !== null) {
    for (const phase of freshState.phases) {
      for (const e of phase.epics) {
        if (e.id === params.epic_id) {
          e.gate_9 = {
            passed: gate9Result.passed,
            evidence_path: evidencePath,
          };
        }
      }
    }
    stateManager.save(freshState);
  }

  // 6b. Run post_accept custom gates (only if Gate 9 passed)
  if (gate9Result.passed) {
    const customResult = runCustomGates("post_accept", params.epic_id, config, projectRoot);
    if (!customResult.passed) {
      // Save custom gate evidence
      const customEvidence: GateEvidence = {
        gate: "custom_post_accept",
        entity_id: params.epic_id,
        passed: false,
        timestamp: new Date().toISOString(),
        checks: customResult.checks,
      };
      evidenceManager.save(customEvidence);

      const lines: string[] = [];
      lines.push(`Epic ${params.epic_id} passed Gate 9 but failed post_accept custom gate.`);
      lines.push("");
      for (const check of customResult.checks) {
        const icon = check.passed ? "PASS" : "FAIL";
        lines.push(`  [${icon}] ${check.name}: ${check.detail}`);
      }
      lines.push("");
      lines.push(`Evidence: ${evidencePath}`);
      return textResult(lines.join("\n"), true);
    }
  }

  // 7. If passed, transition epic to "done"
  if (gate9Result.passed) {
    // Epic should be in "doing" status from review_start
    stateManager.transition(params.epic_id, "done");
  }

  // 8. Build response
  const lines: string[] = [];

  if (gate9Result.passed) {
    lines.push(`Gate 9 PASSED for epic ${params.epic_id}. Epic is now done.`);
  } else {
    lines.push(`Gate 9 FAILED for epic ${params.epic_id}.`);
  }

  lines.push("");
  lines.push("Checks:");
  for (const check of gate9Result.checks) {
    const icon = check.passed ? "PASS" : "FAIL";
    lines.push(`  [${icon}] ${check.name}: ${check.detail}`);
  }

  lines.push("");
  lines.push(`Criteria met: ${gate9Result.criteria_met}/${gate9Result.criteria_total}`);

  if (!gate9Result.passed) {
    const unmet = criteria.filter((c) => !c.met);
    if (unmet.length > 0) {
      lines.push("");
      lines.push("Unmet criteria:");
      for (const c of unmet) {
        lines.push(`  - ${c.criterion}`);
      }
    }
    if (config.gates.gate_9.require_user_approval && !params.user_approved) {
      lines.push("");
      lines.push("User approval: required but not given");
    }
  }

  lines.push("");
  lines.push(`Evidence: ${evidencePath}`);

  return textResult(lines.join("\n"), !gate9Result.passed);
}

// ---------------------------------------------------------------------------
// phase_advance handler
// ---------------------------------------------------------------------------

export function handlePhaseAdvance(
  stateManager: StateManager,
): CallToolResult {
  // 1. Load state
  const state = stateManager.load();
  if (state === null) {
    return textResult("No active cycle. Run cycle_init first.", true);
  }

  // 2. Get current phase
  const currentPhase = state.phases.find(
    (p) => p.id === state.current_phase,
  );

  if (!currentPhase) {
    return textResult(
      `Current phase ${state.current_phase} not found in state.`,
      true,
    );
  }

  // 3. Verify ALL epics in current phase have status "done"
  const incompleteEpics: string[] = [];
  for (const epic of currentPhase.epics) {
    if (epic.status !== "done") {
      incompleteEpics.push(
        `${epic.id} (${epic.name}): status=${epic.status}`,
      );
    }
  }

  if (incompleteEpics.length > 0) {
    const lines: string[] = [];
    lines.push(`Cannot advance phase ${currentPhase.id} — incomplete epics:`);
    for (const e of incompleteEpics) {
      lines.push(`  - ${e}`);
    }
    return textResult(lines.join("\n"), true);
  }

  // 4. Transition current phase to "done"
  if (currentPhase.status !== "done") {
    // Phase might be pending or doing — transition through valid states
    if (currentPhase.status === "pending") {
      stateManager.transition(String(currentPhase.id), "doing");
    }
    stateManager.transition(String(currentPhase.id), "done");
  }

  // 5. Find next phase
  const currentIndex = state.phases.findIndex(
    (p) => p.id === state.current_phase,
  );
  const nextPhase =
    currentIndex + 1 < state.phases.length
      ? state.phases[currentIndex + 1]
      : undefined;

  if (nextPhase) {
    // 6. Set next phase as current and transition to "doing"
    const updatedState = stateManager.load();
    if (updatedState !== null) {
      updatedState.current_phase = nextPhase.id;
      stateManager.save(updatedState);
    }
    stateManager.transition(String(nextPhase.id), "doing");

    const lines: string[] = [];
    lines.push(`Phase ${currentPhase.id} completed.`);
    lines.push(`Advanced to phase ${nextPhase.id} (now doing).`);
    lines.push(`Epics in phase ${nextPhase.id}: ${nextPhase.epics.length}`);

    return textResult(lines.join("\n"));
  }

  // 7. No next phase — cycle complete
  const lines: string[] = [];
  lines.push(`Phase ${currentPhase.id} completed.`);
  lines.push("All phases complete — cycle finished.");

  return textResult(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerReviewTools(
  server: McpServer,
  stateManager: StateManager,
  evidenceManager: EvidenceManager,
  config: RigorConfig,
  projectRoot: string,
): void {
  server.tool(
    "review_start",
    "Start code review for an epic — verifies all tasks are done and passed Gate 0",
    { epic_id: z.string().describe("Epic id (e.g. 1.1)") },
    async (params) => {
      return handleReviewStart(params, stateManager, config, projectRoot);
    },
  );

  server.tool(
    "review_submit",
    "Submit review findings for an epic — runs Gate 8 exit checks",
    {
      epic_id: z.string().describe("Epic id (e.g. 1.1)"),
      submissions: z
        .string()
        .describe("JSON array of ReviewFindings objects"),
    },
    async (params) => {
      return handleReviewSubmit(params, stateManager, evidenceManager, config);
    },
  );

  server.tool(
    "accept_start",
    "Start acceptance for an epic — verifies Gate 8 passed",
    { epic_id: z.string().describe("Epic id (e.g. 1.1)") },
    async (params) => {
      return handleAcceptStart(params, stateManager);
    },
  );

  server.tool(
    "accept_submit",
    "Submit acceptance criteria for an epic — runs Gate 9 exit checks",
    {
      epic_id: z.string().describe("Epic id (e.g. 1.1)"),
      criteria: z
        .string()
        .describe("JSON array of AcceptanceCriterion objects"),
      user_approved: z
        .boolean()
        .default(false)
        .describe("Whether the user has approved the epic"),
    },
    async (params) => {
      return handleAcceptSubmit(params, stateManager, evidenceManager, config, projectRoot);
    },
  );

  server.tool(
    "phase_advance",
    "Advance to the next phase — verifies all epics in current phase are done",
    async () => {
      return handlePhaseAdvance(stateManager);
    },
  );
}
