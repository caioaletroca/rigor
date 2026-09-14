import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { responseResult } from "../tools/response.js";
import type { StateManager } from "../state/index.js";
import { EntityNotFoundError } from "../state/index.js";
import type { RigorConfig } from "../config/index.js";
import { loadConfig } from "../config/index.js";
import type { EvidenceManager, GateEvidence } from "../evidence/index.js";
import { ArchiveManager } from "../archive/manager.js";
import { checkGate8Exit, checkGate9Exit, runCustomGates, Gate9Criteria } from "../gates/index.js";
import type { ReviewFindings, AcceptanceCriterion } from "../gates/index.js";
import { withProjectMutationLock } from "../lifecycle/index.js";

function textResult(text: string, isError?: boolean): CallToolResult { return responseResult(text, { error: isError }); }
export interface ReviewStartParams { epic_id: string; }
export interface ReviewSubmitParams { epic_id: string; submissions: string; }
export interface AcceptStartParams { epic_id: string; }
export interface AcceptSubmitParams { epic_id: string; criteria: string; user_approved: boolean; }

const Gate8Submissions = z.array(z.object({
  reviewer: z.string(),
  verdict: z.enum(["PASS", "ISSUES_FOUND"]),
  findings: z.array(z.object({
    severity: z.enum(["critical", "high", "medium", "low"]),
    file: z.string(),
    title: z.string(),
    description: z.string(),
    suggestion: z.string(),
    source: z.string(),
  })),
}));

export async function handleReviewStart(params: ReviewStartParams, stateManager: StateManager, config: RigorConfig | null, projectRoot: string): Promise<CallToolResult> {
  const cfg = config ?? loadConfig(projectRoot);
  const prepared = await withProjectMutationLock(projectRoot, async () => prepareReviewStart(params, stateManager));
  if ("content" in prepared) return prepared;
  const customResult = await runCustomGates("pre_review", params.epic_id, cfg, projectRoot);
  if (!customResult.passed) {
    const lines = [`Epic ${params.epic_id} blocked by custom pre_review gate.`, ""];
    for (const check of customResult.checks) lines.push(`  [${check.passed ? "PASS" : "FAIL"}] ${check.name}: ${check.detail}`);
    return textResult(lines.join("\n"), true);
  }
  return withProjectMutationLock(projectRoot, async () => {
    const revalidated = prepareReviewStart(params, stateManager);
    if ("content" in revalidated) return revalidated;
    const epic = stateManager.getEpic(params.epic_id);
    if (epic.status === "pending") stateManager.transition(params.epic_id, "doing");
    return textResult([`Review started for epic ${params.epic_id}: ${epic.name}`, `Tasks: ${epic.tasks.length} (all done, all passed Gate 0)`, `Expected reviewers: ${cfg.gates.gate_8.reviewers.join(", ")}`].join("\n"));
  });
}
function prepareReviewStart(params: ReviewStartParams, stateManager: StateManager): CallToolResult | { ready: true } {
  const state = stateManager.load();
  if (state === null) return textResult("No active cycle. Run cycle_init first.", true);
  let epic;
  try { epic = stateManager.getEpic(params.epic_id); } catch (error: unknown) { if (error instanceof EntityNotFoundError) return textResult(`Epic "${params.epic_id}" not found.`, true); throw error; }
  if (epic.tasks.length === 0) return textResult(`Epic "${params.epic_id}" has no tasks — cannot review an epic with no implemented work. Elaborate its tasks into the plan and run cycle_reload before review.`, true);
  if (epic.gate_8.evidence_path) return textResult(epic.gate_8.passed ? `Gate 8 already passed. Run accept_start for epic "${params.epic_id}".` : "Gate 8 already has failed review evidence. Fix the saved findings, then call review_submit directly without another review_start.", true);
  const incomplete = incompleteTaskDetails(epic);
  if (incomplete.length) return incompleteTasksResult(params.epic_id, incomplete, "start review");
  return { ready: true };
}

function incompleteTaskDetails(epic: { tasks: Array<{ id: string; name: string; status: string; gate_0: { passed: boolean } }> }): string[] {
  return epic.tasks
    .filter((task) => task.status !== "done" || !task.gate_0.passed)
    .map((task) => `${task.id} (${task.name}): status=${task.status}, gate_0=${task.gate_0.passed ? "pass" : "fail"}`);
}

function incompleteTasksResult(epicId: string, incomplete: string[], action: string): CallToolResult {
  return textResult([`Cannot ${action} for epic "${epicId}" — incomplete tasks:`, ...incomplete.map((task) => `  - ${task}`)].join("\n"), true);
}

export function handleReviewSubmit(params: ReviewSubmitParams, stateManager: StateManager, evidenceManager: EvidenceManager, config: RigorConfig | null, projectRoot: string): Promise<CallToolResult> { return withProjectMutationLock(projectRoot, async () => reviewSubmit(params, stateManager, evidenceManager, config, projectRoot)); }
function reviewSubmit(params: ReviewSubmitParams, stateManager: StateManager, evidenceManager: EvidenceManager, config: RigorConfig | null, projectRoot: string): CallToolResult {
  const cfg = config ?? loadConfig(projectRoot); if (stateManager.load() === null) return textResult("No active cycle. Run cycle_init first.", true);
  let epic; try { epic = stateManager.getEpic(params.epic_id); } catch (error: unknown) { if (error instanceof EntityNotFoundError) return textResult(`Epic "${params.epic_id}" not found.`, true); throw error; }
  if (epic.status !== "doing") return textResult(`Epic "${params.epic_id}" is in "${epic.status}" status. Only "doing" epics can receive review submissions. Run review_start first.`, true);
  const incomplete = incompleteTaskDetails(epic);
  if (incomplete.length) return incompleteTasksResult(params.epic_id, incomplete, "submit review");
  let parsed: unknown; try { parsed = JSON.parse(params.submissions); } catch { return textResult("Invalid submissions JSON.", true); }
  const validated = Gate8Submissions.safeParse(parsed); if (!validated.success) return textResult(`Invalid submissions JSON: ${validated.error.message}`, true);
  const submissions: ReviewFindings[] = validated.data;
  const result = checkGate8Exit(submissions, cfg); const evidence: GateEvidence = { gate: "gate_8", entity_id: params.epic_id, passed: result.passed, timestamp: new Date().toISOString(), checks: result.checks, review_submissions: submissions }; const path = evidenceManager.save(evidence);
  const state = stateManager.load(); if (state) { for (const phase of state.phases) for (const current of phase.epics) if (current.id === params.epic_id) current.gate_8 = { passed: result.passed, evidence_path: path }; stateManager.save(state); }
  const lines = [result.passed ? `Gate 8 PASSED for epic ${params.epic_id}.` : `Gate 8 FAILED for epic ${params.epic_id}.`, ...(result.passed ? [] : ["Review findings were saved. After remediation, call review_submit directly without another review_start."]), "", "Checks:", ...result.checks.map((check) => `  [${check.passed ? "PASS" : "FAIL"}] ${check.name}: ${check.detail}`)];
  if (result.missing_reviewers.length) lines.push("", `Missing reviewers: ${result.missing_reviewers.join(", ")}`); lines.push("", `Critical findings: ${result.critical_count}`, `High findings: ${result.high_count}`, `Evidence: ${path}`); return textResult(lines.join("\n"), !result.passed);
}
export function handleAcceptStart(params: AcceptStartParams, stateManager: StateManager): CallToolResult {
  if (stateManager.load() === null) return textResult("No active cycle. Run cycle_init first.", true); let epic; try { epic = stateManager.getEpic(params.epic_id); } catch (error: unknown) { if (error instanceof EntityNotFoundError) return textResult(`Epic "${params.epic_id}" not found.`, true); throw error; }
  if (!epic.gate_8.passed) return textResult(`Epic "${params.epic_id}" has not passed Gate 8 (code review). Run review_submit first.`, true); return textResult([`Acceptance started for epic ${params.epic_id}: ${epic.name}`, "Gate 8: passed", "", "Validate the acceptance criteria for this epic and submit via accept_submit."].join("\n"));
}
export async function handleAcceptSubmit(params: AcceptSubmitParams, stateManager: StateManager, evidenceManager: EvidenceManager, config: RigorConfig | null, projectRoot: string): Promise<CallToolResult> {
  const cfg = config ?? loadConfig(projectRoot);
  const prepared = await withProjectMutationLock(projectRoot, async () => prepareAcceptSubmit(params, stateManager));
  if ("content" in prepared) return prepared;
  let parsed: unknown; try { parsed = JSON.parse(params.criteria); } catch { return textResult("Invalid criteria JSON.", true); }
  const validated = Gate9Criteria.safeParse(parsed); if (!validated.success) return textResult(`Invalid criteria JSON: ${validated.error.message}`, true);
  const criteria: AcceptanceCriterion[] = validated.data;
  const result = checkGate9Exit(criteria, params.user_approved, cfg);
  const custom = result.passed ? await runCustomGates("post_accept", params.epic_id, cfg, projectRoot) : null;
  return withProjectMutationLock(projectRoot, async () => {
    const revalidated = prepareAcceptSubmit(params, stateManager);
    if ("content" in revalidated) return revalidated;
    const evidence: GateEvidence = { gate: "gate_9", entity_id: params.epic_id, passed: result.passed, timestamp: new Date().toISOString(), checks: result.checks };
    const path = evidenceManager.save(evidence);
    const state = stateManager.load(); if (state) { for (const phase of state.phases) for (const current of phase.epics) if (current.id === params.epic_id) current.gate_9 = { passed: result.passed, evidence_path: path }; stateManager.save(state); }
    if (custom && !custom.passed) { evidenceManager.save({ gate: "custom_post_accept", entity_id: params.epic_id, passed: false, timestamp: new Date().toISOString(), checks: custom.checks }); return textResult([`Epic ${params.epic_id} passed Gate 9 but failed post_accept custom gate.`, "", ...custom.checks.map((check) => `  [${check.passed ? "PASS" : "FAIL"}] ${check.name}: ${check.detail}`), "", `Evidence: ${path}`].join("\n"), true); }
    if (result.passed) stateManager.transition(params.epic_id, "done");
    const lines = [result.passed ? `Gate 9 PASSED for epic ${params.epic_id}. Epic is now done.` : `Gate 9 FAILED for epic ${params.epic_id}.`, "", "Checks:", ...result.checks.map((check) => `  [${check.passed ? "PASS" : "FAIL"}] ${check.name}: ${check.detail}`), "", `Criteria met: ${result.criteria_met}/${result.criteria_total}`]; if (!result.passed) { const unmet = criteria.filter((criterion) => !criterion.met); if (unmet.length) lines.push("", "Unmet criteria:", ...unmet.map((criterion) => `  - ${criterion.criterion}`)); if (cfg.gates.gate_9.require_user_approval && !params.user_approved) lines.push("", "User approval: required but not given"); } lines.push("", `Evidence: ${path}`); return textResult(lines.join("\n"), !result.passed);
  });
}
function prepareAcceptSubmit(params: AcceptSubmitParams, stateManager: StateManager): CallToolResult | { ready: true } {
  if (stateManager.load() === null) return textResult("No active cycle. Run cycle_init first.", true);
  let epic; try { epic = stateManager.getEpic(params.epic_id); } catch (error: unknown) { if (error instanceof EntityNotFoundError) return textResult(`Epic "${params.epic_id}" not found.`, true); throw error; }
  if (!epic.gate_8.passed) return textResult(`Epic "${params.epic_id}" has not passed Gate 8 (code review). Run review_submit first.`, true);
  if (epic.status !== "doing") return textResult(`Epic "${params.epic_id}" is in "${epic.status}" status. Only "doing" epics can receive acceptance submissions. Run accept_start first.`, true);
  return { ready: true };
}
export function handlePhaseAdvance(stateManager: StateManager, evidenceManager?: EvidenceManager, archiveManager?: ArchiveManager, projectRoot = stateManager.load()?.project_root): Promise<CallToolResult> { if (!projectRoot) return Promise.resolve(phaseAdvance(stateManager, evidenceManager, archiveManager)); return withProjectMutationLock(projectRoot, async () => phaseAdvance(stateManager, evidenceManager, archiveManager)); }
function phaseAdvance(stateManager: StateManager, evidenceManager?: EvidenceManager, archiveManager?: ArchiveManager): CallToolResult {
 const state = stateManager.load(); if (!state) return textResult("No active cycle. Run cycle_init first.", true); const phase = state.phases.find((candidate) => candidate.id === state.current_phase); if (!phase) return textResult(`Current phase ${state.current_phase} not found in state.`, true); const incomplete = phase.epics.filter((epic) => epic.status !== "done"); if (incomplete.length) return textResult([`Cannot advance phase ${phase.id} — incomplete epics:`, ...incomplete.map((epic) => `  - ${epic.id} (${epic.name}): status=${epic.status}`)].join("\n"), true); if (phase.status !== "done") { if (phase.status === "pending") stateManager.transition(String(phase.id), "doing"); stateManager.transition(String(phase.id), "done"); } const index = state.phases.findIndex((candidate) => candidate.id === state.current_phase); const next = state.phases[index + 1]; if (next) { const fresh = stateManager.load(); if (fresh) { fresh.current_phase = next.id; stateManager.save(fresh); } stateManager.transition(String(next.id), "doing"); return textResult([`Phase ${phase.id} completed.`, `Advanced to phase ${next.id} (now doing).`, `Epics in phase ${next.id}: ${next.epics.length}`].join("\n")); } if (!evidenceManager || !archiveManager) return textResult("Cycle completed, but archival dependencies are unavailable. Active artifacts were retained.", true); try { const archive = archiveManager.archive(stateManager.load()!); evidenceManager.clearAll(); try { stateManager.clear(); } catch (error) { archiveManager.restoreEvidence(archive.path); throw error; } return textResult([`Phase ${phase.id} completed.`, "All phases complete — cycle finished.", `Archive: ${archive.path}`, `Archived evidence files: ${archive.evidenceCount}`].join("\n")); } catch (error: unknown) { const detail = error instanceof Error ? error.message : String(error); return textResult(`Cycle completed, but finalization failed. The completed archive was preserved; active cleanup may be incomplete. ${detail}`, true); }
}
