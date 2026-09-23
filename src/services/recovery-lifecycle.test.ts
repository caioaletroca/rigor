/**
 * Tests for recovery tool handlers: cycle_reset, task_manage, epic_manage,
 * phase_manage, cycle_diagnose, and the internal handleTaskRetry helper.
 *
 * Each test gets a fresh temp directory so state files don't collide.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "../state/index.js";
import { EvidenceManager } from "../evidence/index.js";
import type { GateEvidence } from "../evidence/index.js";
import {
  handleCycleReset,
  handleTaskRetry,
  handleTaskManage,
  handleEpicManage,
  handlePhaseManage,
  handleCycleDiagnose,
} from "./recovery-lifecycle.js";
import type { CycleState } from "../state/index.js";
import { DEFAULTS } from "../config/index.js";
import type { RigorConfig } from "../config/index.js";
import * as taskLifecycle from "./task-lifecycle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TextContent {
  type: "text";
  text: string;
}

function extractText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const first = result.content[0] as TextContent;
  return first.text;
}

/**
 * Build a minimal CycleState for testing.
 * By default: 1 phase, 1 epic, 2 tasks (both pending).
 */
function makeCycleState(overrides?: Partial<CycleState>): CycleState {
  const now = new Date().toISOString();
  return {
    cycle_id: "test-cycle",
    plan_path: "/tmp/plan.md",
    current_phase: 1,
    created_at: now,
    updated_at: now,
    phases: [
      {
        id: 1,
        status: "doing",
        epics: [
          {
            id: "1.1",
            name: "Test epic",
            status: "pending",
            tasks: [
              {
                id: "1.1.1",
                name: "First task",
                status: "pending",
                gate_0: { passed: false },
              },
              {
                id: "1.1.2",
                name: "Second task",
                status: "pending",
                gate_0: { passed: false },
              },
            ],
            gate_8: { passed: false },
            gate_9: { passed: false },
          },
        ],
      },
    ],
    ...overrides,
  };
}

/**
 * Write a CycleState directly to .rigor/state.json.
 */
function writeState(projectRoot: string, state: CycleState): void {
  const rigorDir = join(projectRoot, ".rigor");
  if (!existsSync(rigorDir)) {
    mkdirSync(rigorDir, { recursive: true });
  }
  writeFileSync(
    join(rigorDir, "state.json"),
    JSON.stringify(state, null, 2),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("recovery tools", () => {
  let tempDir: string;
  let stateManager: StateManager;
  let evidenceManager: EvidenceManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rigor-recovery-test-"));
    stateManager = new StateManager(tempDir);
    evidenceManager = new EvidenceManager(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // cycle_reset
  // -----------------------------------------------------------------------

  describe("cycle_reset", async () => {
    it("returns error when no active cycle exists", async () => {
      const result = await handleCycleReset(
        { confirm: false },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text).toContain("No active cycle");
    });

    it("returns preview with progress summary when confirm is false", async () => {
      // Create state with 1 done task, 1 pending task
      const state = makeCycleState();
      state.phases[0].epics[0].tasks[0].status = "done";
      state.phases[0].epics[0].tasks[0].gate_0 = {
        passed: true,
        evidence_path: "/some/path.json",
      };
      writeState(tempDir, state);

      // Save an evidence file
      const evidence: GateEvidence = {
        gate: "gate_0",
        entity_id: "1.1.1",
        passed: true,
        timestamp: new Date().toISOString(),
        checks: [],
      };
      evidenceManager.save(evidence);

      const result = await handleCycleReset(
        { confirm: false },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBeUndefined();
      const text = extractText(result);
      expect(text).toContain("Cycle reset preview:");
      expect(text).toContain("test-cycle");
      expect(text).toContain("Tasks: 1/2 done");
      expect(text).toContain("Epics: 0/1 done");
      expect(text).toContain("Evidence files: 1");
      expect(text).toContain("confirm: true to proceed");

      // Verify state is NOT deleted
      expect(stateManager.load()).not.toBeNull();
    });

    it("rejects reset while an in-memory task completion is active", async () => {
      writeState(tempDir, makeCycleState());
      const active = vi.spyOn(taskLifecycle, "isTaskCompletionActive").mockReturnValue(true);

      const result = await handleCycleReset({ confirm: true }, stateManager, evidenceManager, tempDir);

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("Gate 0 completion for task 1.1.1 is executing");
      expect(stateManager.load()).not.toBeNull();
      active.mockRestore();
    });

    it("deletes state and evidence when confirm is true", async () => {
      const state = makeCycleState();
      writeState(tempDir, state);

      // Create evidence files
      evidenceManager.save({
        gate: "gate_0",
        entity_id: "1.1.1",
        passed: true,
        timestamp: new Date().toISOString(),
        checks: [],
      });
      evidenceManager.save({
        gate: "gate_0",
        entity_id: "1.1.2",
        passed: false,
        timestamp: new Date().toISOString(),
        checks: [],
      });

      const result = await handleCycleReset(
        { confirm: true },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBeUndefined();
      const text = extractText(result);
      expect(text).toContain("has been reset");
      expect(text).toContain("2 evidence file(s) deleted");

      // Verify state file is deleted
      expect(stateManager.load()).toBeNull();

      // Verify evidence directory is empty but exists
      const evidenceDir = join(tempDir, ".rigor", "evidence");
      expect(existsSync(evidenceDir)).toBe(true);
      expect(readdirSync(evidenceDir)).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // handleTaskRetry (internal helper, also used by task_manage retry action)
  // -----------------------------------------------------------------------

  describe("handleTaskRetry", async () => {
    it("returns error when no active cycle exists", async () => {
      const result = handleTaskRetry(
        { task_id: "1.1.1" },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text).toContain("No active cycle");
    });

    it("returns error when task is not found", async () => {
      const state = makeCycleState();
      writeState(tempDir, state);

      const result = handleTaskRetry(
        { task_id: "9.9.9" },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text).toContain("not found");
    });

    it("rejects task not in failed status", async () => {
      const state = makeCycleState();
      writeState(tempDir, state);

      const result = handleTaskRetry(
        { task_id: "1.1.1" },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text).toContain('"pending"');
      expect(text).toContain("Only \"failed\" tasks can be retried");
    });

    it("clears nested attempt history during cycle reset", async () => {
      const state = makeCycleState();
      writeState(tempDir, state);
      evidenceManager.saveTerminalGate0Attempt({
        gate: "gate_0", entity_id: "1.1.1", passed: false, timestamp: new Date().toISOString(), checks: [],
        gate_0_attempt: { version: 1, id: "attempt-1", started_at: "2026-09-08T00:00:00.000Z", finished_at: "2026-09-08T00:01:00.000Z", outcome: "failed" },
      });

      const text = extractText(await handleCycleReset({ confirm: true }, stateManager, evidenceManager, tempDir));
      expect(text).toContain("2 evidence file(s) deleted");
      expect(readdirSync(join(tempDir, ".rigor", "evidence"))).toHaveLength(0);
    });

    it("clears gate_0 evidence and returns previous failure reason", async () => {
      // Set up a failed task with evidence
      const state = makeCycleState();
      const evidencePath = evidenceManager.save({
        gate: "gate_0",
        entity_id: "1.1.1",
        passed: false,
        timestamp: new Date().toISOString(),
        checks: [
          {
            name: "tests",
            passed: false,
            detail: "2 tests failed",
          },
          {
            name: "lint",
            passed: true,
            detail: "No lint errors",
          },
        ],
        gate_0_attempt: {
          version: 1,
          id: "failed-attempt",
          started_at: "2026-09-08T00:00:00.000Z",
          finished_at: "2026-09-08T00:01:00.000Z",
          outcome: "failed",
        },
      });
      evidenceManager.saveTerminalGate0Attempt(evidenceManager.load("gate_0", "1.1.1")!);

      state.phases[0].epics[0].tasks[0].status = "failed";
      state.phases[0].epics[0].tasks[0].gate_0 = {
        passed: false,
        evidence_path: evidencePath,
      };
      writeState(tempDir, state);

      const result = handleTaskRetry(
        { task_id: "1.1.1" },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBeUndefined();
      const text = extractText(result);
      expect(text).toContain("ready for retry");
      expect(text).toContain("tests: 2 tests failed");
      expect(text).toContain("task_start");

      // Verify current evidence was deleted but immutable terminal history remains.
      expect(existsSync(evidencePath)).toBe(false);
      expect(existsSync(evidenceManager.attemptPathFor("1.1.1", "failed-attempt"))).toBe(true);

      // Verify gate_0 was reset in state
      const updatedState = stateManager.load();
      const task = updatedState?.phases[0].epics[0].tasks[0];
      expect(task?.gate_0.passed).toBe(false);
      expect(task?.gate_0.evidence_path).toBeUndefined();
    });

    it("handles failed task with no prior evidence gracefully", async () => {
      const state = makeCycleState();
      state.phases[0].epics[0].tasks[0].status = "failed";
      writeState(tempDir, state);

      const result = handleTaskRetry(
        { task_id: "1.1.1" },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBeUndefined();
      const text = extractText(result);
      expect(text).toContain("ready for retry");
      expect(text).toContain("No prior evidence found");
      expect(text).toContain("task_start");

      // Verify gate_0 was reset
      const updatedState = stateManager.load();
      const task = updatedState?.phases[0].epics[0].tasks[0];
      expect(task?.gate_0.passed).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // cycle_diagnose
  // -----------------------------------------------------------------------

  describe("cycle_diagnose", async () => {
    it("returns no active cycle when no state exists", async () => {
      const result = await handleCycleDiagnose(
        stateManager,
        evidenceManager,
        tempDir,
      );

      const text = extractText(result);
      expect(text).toContain("No active cycle");
    });

    it("reports healthy status when all is valid", async () => {
      const state = makeCycleState();
      writeState(tempDir, state);

      const result = await handleCycleDiagnose(
        stateManager,
        evidenceManager,
        tempDir,
      );

      const text = extractText(result);
      expect(text).toContain("Health: healthy");
      expect(text).toContain("test-cycle");
      expect(text).toContain("0/2 tasks");
      expect(text).toContain("0/1 epics");
    });

    it("reports degraded status when stuck entities exist", async () => {
      const state = makeCycleState();
      // A task stuck in "doing"
      state.phases[0].epics[0].tasks[0].status = "doing";
      writeState(tempDir, state);

      const result = await handleCycleDiagnose(
        stateManager,
        evidenceManager,
        tempDir,
      );

      const text = extractText(result);
      expect(text).toContain("Health: degraded");
      expect(text).toContain("Stuck entities:");
      expect(text).toContain("task 1.1.1");
      expect(text).toContain("First task");
    });

    it("reports an unfinished persisted Gate 0 attempt as stuck when it is not in-process", async () => {
      const state = makeCycleState();
       state.phases[0].epics[0].tasks[0].status = "doing";
       state.phases[0].epics[0].tasks[0].worker = { owner_id: "owner-a", started_at: new Date().toISOString() };
       writeState(tempDir, state);
       evidenceManager.save({
         gate: "gate_0",
         entity_id: "1.1.1",
        passed: false,
        timestamp: new Date().toISOString(),
        checks: [],
        gate_0_attempt: {
          version: 1,
          id: "attempt-123",
          started_at: new Date().toISOString(),
          current_check: {
            check_name: "tests",
            command: "npm test",
            started_at: new Date(Date.now() - 100).toISOString(),
            configured_timeout_ms: 5000,
          },
        },
      });

       const text = extractText(await handleCycleDiagnose(stateManager, evidenceManager, tempDir));
       expect(text).not.toContain("Executing Gate 0 attempts:");
       expect(text).toContain("Recovery:");
       expect(text).toContain("interrupted");
       expect(text).toContain('task_manage({ task_id: "1.1.1", action: "retry", confirm: true');
       expect(text).not.toContain("Stuck entities:");
        expect(stateManager.getTask("1.1.1").status).toBe("failed");
        expect(stateManager.getTask("1.1.1").worker).toBeUndefined();
        expect(evidenceManager.load("gate_0", "1.1.1")?.gate_0_attempt).toMatchObject({
          outcome: "interrupted",
          finished_at: expect.any(String),
        });
        expect(existsSync(evidenceManager.attemptPathFor("1.1.1", "attempt-123"))).toBe(true);
      });

       it("classifies an inactive recent attempt as interrupted before the stale threshold", async () => {
         const state = makeCycleState();
         state.phases[0].epics[0].tasks[0].status = "doing";
         writeState(tempDir, state);
         evidenceManager.save({
           gate: "gate_0", entity_id: "1.1.1", passed: false, timestamp: new Date().toISOString(), checks: [],
           gate_0_attempt: { version: 1, id: "recent-attempt", started_at: new Date(Date.now() - 1000).toISOString() },
         });

         const text = extractText(await handleCycleDiagnose(stateManager, evidenceManager, tempDir));

         expect(text).toContain("interrupted");
         expect(text).not.toContain("stale");
         expect(text).toContain('task_manage({ task_id: "1.1.1", action: "retry", confirm: true');
       });

       it("classifies an inactive old attempt as stale and recommends retry", async () => {
        const state = makeCycleState();
        state.phases[0].epics[0].tasks[0].status = "doing";
        state.phases[0].epics[0].tasks[0].worker = { owner_id: "owner-a", started_at: new Date().toISOString() };
        writeState(tempDir, state);
        evidenceManager.save({
          gate: "gate_0", entity_id: "1.1.1", passed: false, timestamp: new Date().toISOString(), checks: [],
          gate_0_attempt: { version: 1, id: "stale-attempt", started_at: new Date(Date.now() - 6 * 60 * 1000).toISOString() },
         });

         const text = extractText(await handleCycleDiagnose(stateManager, evidenceManager, tempDir));

         expect(text).toContain("stale");
         expect(text).toContain("interrupted");
         expect(text).toContain('task_manage({ task_id: "1.1.1", action: "retry", confirm: true');
         expect(stateManager.getTask("1.1.1").status).toBe("failed");
         expect(stateManager.getTask("1.1.1").worker).toBeUndefined();
       });

       it("reconciles terminal Gate 0 evidence left with a doing task idempotently", async () => {
        const state = makeCycleState();
        state.phases[0].epics[0].tasks[0].status = "doing";
        writeState(tempDir, state);
        evidenceManager.save({
          gate: "gate_0", entity_id: "1.1.1", passed: true, timestamp: new Date().toISOString(), checks: [],
          gate_0_attempt: { version: 1, id: "attempt-123", started_at: new Date().toISOString(), finished_at: new Date().toISOString(), outcome: "passed" },
        });

        await handleCycleDiagnose(stateManager, evidenceManager, tempDir);
        const updatedAt = stateManager.load()?.updated_at;
        await handleCycleDiagnose(stateManager, evidenceManager, tempDir);

        expect(stateManager.getTask("1.1.1").status).toBe("done");
        expect(stateManager.load()?.updated_at).toBe(updatedAt);
      });

      it("fails an interrupted post_task boundary without rerunning custom gates", async () => {
        const state = makeCycleState();
        state.phases[0].epics[0].tasks[0].status = "doing";
        writeState(tempDir, state);
        evidenceManager.save({
          gate: "gate_0", entity_id: "1.1.1", passed: true, timestamp: new Date().toISOString(), checks: [],
          gate_0_attempt: { version: 1, id: "attempt-123", started_at: new Date().toISOString(), finished_at: new Date().toISOString(), outcome: "passed" },
        });
        const config: RigorConfig = {
          ...DEFAULTS,
          gates: {
            ...DEFAULTS.gates,
            custom_gates: [{ name: "post-task", command: "exit 0", position: "post_task" }],
          },
        };

        const text = extractText(await handleCycleDiagnose(stateManager, evidenceManager, tempDir, config));

        expect(text).toContain("post_task_unproven");
        expect(text).toContain('task_manage({ task_id: "1.1.1", action: "retry", confirm: true');
        expect(text).not.toContain("Terminal Gate 0 evidence mismatches:");
        expect(text).not.toContain('task_manage({ task_id: "1.1.1", action: "reset_evidence", confirm: true');
        expect(stateManager.getTask("1.1.1").status).toBe("failed");
        expect(stateManager.getTask("1.1.1").gate_0.passed).toBe(false);
        expect(evidenceManager.load("custom_post_task", "1.1.1")).toBeNull();
      });

      it("does not restore historical evidence after a retry starts without current evidence", async () => {
        const state = makeCycleState();
        state.phases[0].epics[0].tasks[0].status = "failed";
        writeState(tempDir, state);
        evidenceManager.saveTerminalGate0Attempt({
          gate: "gate_0", entity_id: "1.1.1", passed: false, timestamp: "2026-09-08T00:01:00.000Z", checks: [],
          gate_0_attempt: { version: 1, id: "attempt-failed", started_at: "2026-09-08T00:00:00.000Z", finished_at: "2026-09-08T00:01:00.000Z", outcome: "failed" },
        });

        handleTaskRetry({ task_id: "1.1.1" }, stateManager, evidenceManager, tempDir);
        stateManager.transition("1.1.1", "doing");

        const text = extractText(await handleCycleDiagnose(stateManager, evidenceManager, tempDir));

        expect(text).not.toContain("Recovery:");
        expect(stateManager.getTask("1.1.1").status).toBe("doing");
        expect(evidenceManager.load("gate_0", "1.1.1")).toBeNull();
        expect(existsSync(evidenceManager.attemptPathFor("1.1.1", "attempt-failed"))).toBe(true);
      });

      it("marks a crashed retry interrupted without restoring older terminal history", async () => {
        const state = makeCycleState();
        state.phases[0].epics[0].tasks[0].status = "failed";
        writeState(tempDir, state);
        evidenceManager.saveTerminalGate0Attempt({
          gate: "gate_0", entity_id: "1.1.1", passed: false, timestamp: "2026-09-08T00:01:00.000Z", checks: [],
          gate_0_attempt: { version: 1, id: "attempt-failed", started_at: "2026-09-08T00:00:00.000Z", finished_at: "2026-09-08T00:01:00.000Z", outcome: "failed" },
        });

        handleTaskRetry({ task_id: "1.1.1" }, stateManager, evidenceManager, tempDir);
        stateManager.transition("1.1.1", "doing");
        const retryState = stateManager.load()!;
        retryState.phases[0].epics[0].tasks[0].worker = { owner_id: "owner-a", started_at: new Date().toISOString() };
        stateManager.save(retryState);
        evidenceManager.save({
          gate: "gate_0", entity_id: "1.1.1", passed: false, timestamp: "2026-09-08T00:02:00.000Z", checks: [],
          gate_0_attempt: { version: 1, id: "attempt-retry", started_at: "2026-09-08T00:02:00.000Z" },
        });

        const text = extractText(await handleCycleDiagnose(stateManager, evidenceManager, tempDir));

        expect(text).toContain("interrupted");
       expect(stateManager.getTask("1.1.1").status).toBe("failed");
       expect(stateManager.getTask("1.1.1").worker).toBeUndefined();
         expect(evidenceManager.load("gate_0", "1.1.1")?.gate_0_attempt).toMatchObject({
          id: "attempt-retry",
          outcome: "interrupted",
          finished_at: expect.any(String),
        });
        expect(evidenceManager.load("gate_0", "1.1.1")?.passed).toBe(false);
        expect(evidenceManager.load("gate_0", "1.1.1")?.checks).toContainEqual(expect.objectContaining({
          detail: expect.stringContaining("interrupted"),
        }));
        expect(existsSync(evidenceManager.attemptPathFor("1.1.1", "attempt-failed"))).toBe(true);
        expect(existsSync(evidenceManager.attemptPathFor("1.1.1", "attempt-retry"))).toBe(true);
        handleTaskRetry({ task_id: "1.1.1" }, stateManager, evidenceManager, tempDir);
        expect(evidenceManager.taskEvidenceSummary("1.1.1")).toEqual({
          latest: undefined,
          prior: ["interrupted", "failed"],
        });
      });


      it.each(["failed", "timed_out", "cancelled", "execution_error"] as const)("reconciles %s terminal evidence from doing to failed", async (outcome) => {
        const state = makeCycleState();
        state.phases[0].epics[0].tasks[0].status = "doing";
        writeState(tempDir, state);
        evidenceManager.save({
          gate: "gate_0", entity_id: "1.1.1", passed: false, timestamp: new Date().toISOString(), checks: [],
          gate_0_attempt: { version: 1, id: "attempt-123", started_at: new Date().toISOString(), finished_at: new Date().toISOString(), outcome },
        });

        await handleCycleDiagnose(stateManager, evidenceManager, tempDir);

        expect(stateManager.getTask("1.1.1").status).toBe("failed");
      });

      it("reports terminal evidence mismatched with a non-doing task without mutation", async () => {
        const state = makeCycleState();
        state.phases[0].epics[0].tasks[0].status = "done";
        writeState(tempDir, state);
        const evidence = {
          gate: "gate_0" as const, entity_id: "1.1.1", passed: false, timestamp: new Date().toISOString(), checks: [],
          gate_0_attempt: { version: 1 as const, id: "attempt-123", started_at: new Date().toISOString(), finished_at: new Date().toISOString(), outcome: "timed_out" as const },
        };
        evidenceManager.save(evidence);
        const evidencePath = evidenceManager.pathFor("gate_0", "1.1.1");
        const before = JSON.stringify(evidenceManager.load("gate_0", "1.1.1"));

        const text = extractText(await handleCycleDiagnose(stateManager, evidenceManager, tempDir));

        expect(text).toContain("Terminal Gate 0 evidence mismatches:");
        expect(text).toContain("timed_out evidence conflicts with task status");
        expect(text).toContain('task_manage({ task_id: "1.1.1", action: "reset_evidence", confirm: true');
        expect(stateManager.getTask("1.1.1").status).toBe("done");
        expect(JSON.stringify(evidenceManager.load("gate_0", "1.1.1"))).toBe(before);
        expect(existsSync(evidencePath)).toBe(true);
      });

      it("reports a successful recovered attempt as requiring no action", async () => {
        const state = makeCycleState();
       state.phases[0].epics[0].tasks[0].status = "doing";
       writeState(tempDir, state);
       evidenceManager.save({
         gate: "gate_0", entity_id: "1.1.1", passed: true, timestamp: new Date().toISOString(), checks: [],
         gate_0_attempt: { version: 1, id: "attempt-123", started_at: new Date().toISOString(), finished_at: new Date().toISOString(), outcome: "passed" },
       });

       const text = extractText(await handleCycleDiagnose(stateManager, evidenceManager, tempDir));
       expect(text).toContain("terminal_passed");
       expect(text).toContain("Reconciled to done; no action required.");
       expect(text).not.toContain('task_manage({ task_id: "1.1.1", action: "retry", confirm: true');
     });

      it("summarizes latest and prior Gate 0 attempts", async () => {
        const state = makeCycleState();
        writeState(tempDir, state);
        evidenceManager.saveTerminalGate0Attempt({
          gate: "gate_0", entity_id: "1.1.1", passed: false, timestamp: new Date().toISOString(), checks: [],
          gate_0_attempt: { version: 1, id: "attempt-1", started_at: "2026-09-08T00:00:00.000Z", finished_at: "2026-09-08T00:01:00.000Z", outcome: "failed" },
        });
        evidenceManager.saveTerminalGate0Attempt({
          gate: "gate_0", entity_id: "1.1.1", passed: true, timestamp: new Date().toISOString(), checks: [],
          gate_0_attempt: { version: 1, id: "attempt-2", started_at: "2026-09-08T00:02:00.000Z", finished_at: "2026-09-08T00:03:00.000Z", outcome: "passed" },
        });

        const text = extractText(await handleCycleDiagnose(stateManager, evidenceManager, tempDir));
        expect(text).toContain("Gate 0 attempt history:");
        expect(text).toContain("latest passed; prior failed");
      });

      it("reports inconsistent evidence with the minimal repair action", async () => {
       const state = makeCycleState();
       state.phases[0].epics[0].tasks[0].status = "doing";
       writeState(tempDir, state);
       evidenceManager.save({
         gate: "gate_0", entity_id: "1.1.1", passed: false, timestamp: new Date().toISOString(), checks: [],
         gate_0_attempt: { version: 1, id: "attempt-123", started_at: new Date().toISOString(), finished_at: new Date().toISOString(), outcome: "passed" },
       });

       const text = extractText(await handleCycleDiagnose(stateManager, evidenceManager, tempDir));
       expect(text).toContain("inconsistent");
       expect(text).toContain('task_manage({ task_id: "1.1.1", action: "reset_evidence", confirm: true');
     });

     it("reports corrupt status when validation errors exist", async () => {
      // Create a state with an invalid current_phase
      const state = makeCycleState();
      state.current_phase = 999;
      writeState(tempDir, state);

      const result = await handleCycleDiagnose(
        stateManager,
        evidenceManager,
        tempDir,
      );

      const text = extractText(result);
      expect(text).toContain("Health: corrupt");
      expect(text).toContain("[ERROR]");
      expect(text).toContain("current_phase");
    });

    it("detects missing evidence for done tasks", async () => {
      const state = makeCycleState();
      // Mark task as done but don't create evidence
      state.phases[0].epics[0].tasks[0].status = "done";
      state.phases[0].epics[0].tasks[0].gate_0 = { passed: true };
      writeState(tempDir, state);

      const result = await handleCycleDiagnose(
        stateManager,
        evidenceManager,
        tempDir,
      );

      const text = extractText(result);
      expect(text).toContain("Evidence audit: 1 missing");
      expect(text).toContain("Task 1.1.1: missing gate_0 evidence");
    });

    it("detects missing evidence for done epics", async () => {
      const state = makeCycleState();
      // Mark epic and all its tasks as done
      state.phases[0].epics[0].status = "done";
      for (const task of state.phases[0].epics[0].tasks) {
        task.status = "done";
        task.gate_0 = { passed: true };
        // Create task evidence
        evidenceManager.save({
          gate: "gate_0",
          entity_id: task.id,
          passed: true,
          timestamp: new Date().toISOString(),
          checks: [],
        });
      }
      state.phases[0].epics[0].gate_8 = { passed: true };
      state.phases[0].epics[0].gate_9 = { passed: true };
      writeState(tempDir, state);

      // No gate_8 or gate_9 evidence files exist on disk
      const result = await handleCycleDiagnose(
        stateManager,
        evidenceManager,
        tempDir,
      );

      const text = extractText(result);
      expect(text).toContain("Evidence audit: 2 missing");
      expect(text).toContain("Epic 1.1: missing gate_8 evidence");
      expect(text).toContain("Epic 1.1: missing gate_9 evidence");
    });

    it("suggests task_manage for stuck tasks", async () => {
      const state = makeCycleState();
      state.phases[0].epics[0].tasks[0].status = "doing";
      writeState(tempDir, state);

      const result = await handleCycleDiagnose(
        stateManager,
        evidenceManager,
        tempDir,
      );

      const text = extractText(result);
      expect(text).toContain("Stuck entities:");
      expect(text).toContain('task_manage({ task_id: "1.1.1", action: "force_status", target_status: "failed", confirm: true');
      expect(text).toContain('task_manage({ task_id: "1.1.1", action: "retry", confirm: true');
    });

    it("suggests task_manage retry for failed tasks", async () => {
      const state = makeCycleState();
      state.phases[0].epics[0].tasks[0].status = "failed";
      writeState(tempDir, state);

      const result = await handleCycleDiagnose(
        stateManager,
        evidenceManager,
        tempDir,
      );

      const text = extractText(result);
      expect(text).toContain("Failed tasks:");
      expect(text).toContain('task_manage({ task_id: "1.1.1", action: "retry", confirm: true');
    });

    it("suggests epic_manage for stuck epics", async () => {
      const state = makeCycleState();
      state.phases[0].epics[0].status = "doing";
      writeState(tempDir, state);

      const result = await handleCycleDiagnose(
        stateManager,
        evidenceManager,
        tempDir,
      );

      const text = extractText(result);
      expect(text).toContain("Stuck entities:");
      expect(text).toContain('epic_manage({ epic_id: "1.1", action: "force_status", target_status: "pending", cascade: false, confirm: true');
    });

    it("suggests task_manage reset_evidence for missing task evidence", async () => {
      const state = makeCycleState();
      state.phases[0].epics[0].tasks[0].status = "done";
      state.phases[0].epics[0].tasks[0].gate_0 = { passed: true };
      // No evidence file on disk
      writeState(tempDir, state);

      const result = await handleCycleDiagnose(
        stateManager,
        evidenceManager,
        tempDir,
      );

      const text = extractText(result);
      expect(text).toContain("Evidence audit:");
      expect(text).toContain("Task 1.1.1: missing gate_0 evidence");
      expect(text).toContain('task_manage({ task_id: "1.1.1", action: "reset_evidence", confirm: true');
    });

    it("excludes skipped entities from progress totals", async () => {
      const state = makeCycleState();
      // 2 tasks total: skip one, leave one pending
      state.phases[0].epics[0].tasks[0].status = "skipped";
      writeState(tempDir, state);

      const result = await handleCycleDiagnose(
        stateManager,
        evidenceManager,
        tempDir,
      );

      const text = extractText(result);
      // 1 active task (the non-skipped one), 0 done
      expect(text).toContain("0/1 tasks");
      // Epic is still active (pending, not skipped)
      expect(text).toContain("0/1 epics");
    });

    it("excludes skipped epics from progress totals", async () => {
      const state = makeCycleState();
      state.phases[0].epics[0].status = "skipped";
      // Also skip all tasks so we get clean counts
      state.phases[0].epics[0].tasks[0].status = "skipped";
      state.phases[0].epics[0].tasks[1].status = "skipped";
      writeState(tempDir, state);

      const result = await handleCycleDiagnose(
        stateManager,
        evidenceManager,
        tempDir,
      );

      const text = extractText(result);
      // All skipped — 0 active
      expect(text).toContain("0/0 tasks");
      expect(text).toContain("0/0 epics");
    });

    it("suggests phase_manage for stuck phases", async () => {
      const state = makeCycleState();
      // Add a second phase stuck in "doing" (non-current phase)
      state.phases.push({
        id: 2,
        status: "doing",
        epics: [
          {
            id: "2.1",
            name: "Phase 2 epic",
            status: "pending",
            tasks: [
              {
                id: "2.1.1",
                name: "Phase 2 task",
                status: "pending",
                gate_0: { passed: false },
              },
            ],
            gate_8: { passed: false },
            gate_9: { passed: false },
          },
        ],
      });
      writeState(tempDir, state);

      const result = await handleCycleDiagnose(
        stateManager,
        evidenceManager,
        tempDir,
      );

      const text = extractText(result);
      expect(text).toContain("Stuck entities:");
      expect(text).toContain('phase_manage({ phase_id: "2", action: "force_status", target_status: "pending", confirm: true');
    });
  });

  // -----------------------------------------------------------------------
  // task_manage
  // -----------------------------------------------------------------------

  describe("task_manage", async () => {
    it("returns error when no active cycle exists", async () => {
      const result = await handleTaskManage(
        { task_id: "1.1.1", action: "skip", confirm: false },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("No active cycle");
    });

    it("returns error when task is not found", async () => {
      writeState(tempDir, makeCycleState());

      const result = await handleTaskManage(
        { task_id: "9.9.9", action: "skip", confirm: false },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("not found");
    });

    it("manages a doing task without ownership parameters", async () => {
      const state = makeCycleState();
      state.phases[0].epics[0].tasks[0].status = "doing";
      writeState(tempDir, state);

      const result = await handleTaskManage(
        { task_id: "1.1.1", action: "force_status", target_status: "failed", confirm: true },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBeUndefined();
      expect(stateManager.getTask("1.1.1").status).toBe("failed");
    });

    // ----- force_status -----

    describe("force_status", async () => {
      it("requires target_status parameter", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handleTaskManage(
          { task_id: "1.1.1", action: "force_status", confirm: false },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBe(true);
        expect(extractText(result)).toContain("target_status");
      });

      it("rejects invalid target_status", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handleTaskManage(
          {
            task_id: "1.1.1",
            action: "force_status",
            target_status: "invalid",
            confirm: false,
          },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBe(true);
        expect(extractText(result)).toContain("Invalid target_status");
      });

      it("returns preview without mutating state", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handleTaskManage(
          {
            task_id: "1.1.1",
            action: "force_status",
            target_status: "done",
            confirm: false,
          },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        const text = extractText(result);
        expect(text).toContain("force_status preview");
        expect(text).toContain("1.1.1");
        expect(text).toContain("pending");
        expect(text).toContain("done");
        expect(text).toContain("confirm: true");

        // State unchanged
        expect(stateManager.getTask("1.1.1").status).toBe("pending");
      });

      it("applies force_status on confirm", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handleTaskManage(
          {
            task_id: "1.1.1",
            action: "force_status",
            target_status: "done",
            confirm: true,
          },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        expect(extractText(result)).toContain('forced from "pending" to "done"');
        expect(stateManager.getTask("1.1.1").status).toBe("done");
      });

      it("clears evidence on backward transition (done -> pending)", async () => {
        const state = makeCycleState();
        state.phases[0].epics[0].tasks[0].status = "done";
        state.phases[0].epics[0].tasks[0].gate_0 = { passed: true };
        writeState(tempDir, state);

        // Create evidence
        evidenceManager.save({
          gate: "gate_0",
          entity_id: "1.1.1",
          passed: true,
          timestamp: new Date().toISOString(),
          checks: [],
        });

        // Preview should mention evidence cleanup
        const preview = await handleTaskManage(
          {
            task_id: "1.1.1",
            action: "force_status",
            target_status: "pending",
            confirm: false,
          },
          stateManager,
          evidenceManager,
          tempDir,
        );
        expect(extractText(preview)).toContain("will be deleted");

        // Confirm
        const result = await handleTaskManage(
          {
            task_id: "1.1.1",
            action: "force_status",
            target_status: "pending",
            confirm: true,
          },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(extractText(result)).toContain("Evidence cleared");
        expect(stateManager.getTask("1.1.1").status).toBe("pending");
        expect(evidenceManager.load("gate_0", "1.1.1")).toBeNull();
      });

      it("preserves evidence on forward transition", async () => {
        writeState(tempDir, makeCycleState());

        evidenceManager.save({
          gate: "gate_0",
          entity_id: "1.1.1",
          passed: true,
          timestamp: new Date().toISOString(),
          checks: [],
        });

        // Preview should mention evidence preserved
        const preview = await handleTaskManage(
          {
            task_id: "1.1.1",
            action: "force_status",
            target_status: "done",
            confirm: false,
          },
          stateManager,
          evidenceManager,
          tempDir,
        );
        expect(extractText(preview)).toContain("will be preserved");

        await handleTaskManage(
          {
            task_id: "1.1.1",
            action: "force_status",
            target_status: "done",
            confirm: true,
          },
          stateManager,
          evidenceManager,
          tempDir,
        );

        // Evidence still exists
        expect(evidenceManager.load("gate_0", "1.1.1")).not.toBeNull();
      });
    });

    // ----- skip -----

    describe("skip", async () => {
      it("returns preview without mutating state", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handleTaskManage(
          { task_id: "1.1.1", action: "skip", confirm: false },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        const text = extractText(result);
        expect(text).toContain("skip preview");
        expect(text).toContain("skipped");
        expect(stateManager.getTask("1.1.1").status).toBe("pending");
      });

      it("transitions task to skipped on confirm", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handleTaskManage(
          { task_id: "1.1.1", action: "skip", confirm: true },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        expect(extractText(result)).toContain("skipped");
        expect(stateManager.getTask("1.1.1").status).toBe("skipped");
      });

      it("rejects skip from already-skipped status", async () => {
        const state = makeCycleState();
        state.phases[0].epics[0].tasks[0].status = "skipped";
        writeState(tempDir, state);

        const result = await handleTaskManage(
          { task_id: "1.1.1", action: "skip", confirm: true },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBe(true);
        expect(extractText(result)).toContain("not allowed");
      });
    });

    // ----- retry -----

    describe("retry", async () => {
      it("returns error preview for non-failed tasks", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handleTaskManage(
          { task_id: "1.1.1", action: "retry", confirm: false },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBe(true);
        expect(extractText(result)).toContain("pending");
        expect(extractText(result)).toContain("Only \"failed\"");
      });

      it("returns preview for failed tasks with evidence info", async () => {
        const state = makeCycleState();
        state.phases[0].epics[0].tasks[0].status = "failed";
        writeState(tempDir, state);

        evidenceManager.save({
          gate: "gate_0",
          entity_id: "1.1.1",
          passed: false,
          timestamp: new Date().toISOString(),
          checks: [
            { name: "tests", passed: false, detail: "3 failures" },
          ],
        });

        const result = await handleTaskManage(
          { task_id: "1.1.1", action: "retry", confirm: false },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        const text = extractText(result);
        expect(text).toContain("retry preview");
        expect(text).toContain("tests: 3 failures");
        expect(text).toContain("confirm: true");
      });

      it("delegates to handleTaskRetry on confirm", async () => {
        const state = makeCycleState();
        state.phases[0].epics[0].tasks[0].status = "failed";
        writeState(tempDir, state);

        evidenceManager.save({
          gate: "gate_0",
          entity_id: "1.1.1",
          passed: false,
          timestamp: new Date().toISOString(),
          checks: [
            { name: "tests", passed: false, detail: "2 failures" },
          ],
        });

        const result = await handleTaskManage(
          { task_id: "1.1.1", action: "retry", confirm: true },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        expect(extractText(result)).toContain("ready for retry");
        expect(evidenceManager.load("gate_0", "1.1.1")).toBeNull();
      });
    });

    // ----- reset_evidence -----

    describe("reset_evidence", async () => {
      it("returns preview showing what evidence exists", async () => {
        writeState(tempDir, makeCycleState());

        evidenceManager.save({
          gate: "gate_0",
          entity_id: "1.1.1",
          passed: true,
          timestamp: new Date().toISOString(),
          checks: [],
        });

        const result = await handleTaskManage(
          { task_id: "1.1.1", action: "reset_evidence", confirm: false },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        const text = extractText(result);
        expect(text).toContain("reset_evidence preview");
        expect(text).toContain("gate_0");
        expect(text).toContain("will NOT change");
      });

      it("returns preview showing no evidence when none exists", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handleTaskManage(
          { task_id: "1.1.1", action: "reset_evidence", confirm: false },
          stateManager,
          evidenceManager,
          tempDir,
        );

        const text = extractText(result);
        expect(text).toContain("0 file(s)");
      });

      it("deletes all evidence without changing status on confirm", async () => {
        const state = makeCycleState();
        state.phases[0].epics[0].tasks[0].status = "done";
        writeState(tempDir, state);

        evidenceManager.save({
          gate: "gate_0",
          entity_id: "1.1.1",
          passed: true,
          timestamp: new Date().toISOString(),
          checks: [],
        });
        evidenceManager.save({ gate: "gate_1", entity_id: "1.1.1", passed: true, timestamp: new Date().toISOString(), checks: [] });
        evidenceManager.save({ gate: "custom_post_task", entity_id: "1.1.1", passed: true, timestamp: new Date().toISOString(), checks: [] });
        evidenceManager.saveTerminalGate0Attempt({
          gate: "gate_0", entity_id: "1.1.1", passed: false, timestamp: new Date().toISOString(), checks: [],
          gate_0_attempt: { version: 1, id: "reset-attempt", started_at: "2026-09-08T00:00:00.000Z", finished_at: "2026-09-08T00:01:00.000Z", outcome: "failed" },
        });

        const result = await handleTaskManage(
          { task_id: "1.1.1", action: "reset_evidence", confirm: true },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        const text = extractText(result);
        expect(text).toContain("4 file(s) deleted");
        expect(text).toContain("Status unchanged (done)");
        expect(evidenceManager.load("gate_0", "1.1.1")).toBeNull();
        expect(evidenceManager.load("gate_1", "1.1.1")).toBeNull();
        expect(evidenceManager.load("custom_post_task", "1.1.1")).toBeNull();
        expect(existsSync(evidenceManager.attemptPathFor("1.1.1", "reset-attempt"))).toBe(false);
        expect(stateManager.getTask("1.1.1").status).toBe("done");
      });
    });
  });

  // -----------------------------------------------------------------------
  // epic_manage
  // -----------------------------------------------------------------------

  describe("epic_manage", async () => {
    it("returns error when no active cycle exists", async () => {
      const result = await handleEpicManage(
        { epic_id: "1.1", action: "skip", cascade: false, confirm: false },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("No active cycle");
    });

    it("returns error when epic is not found", async () => {
      writeState(tempDir, makeCycleState());

      const result = await handleEpicManage(
        { epic_id: "9.9", action: "skip", cascade: false, confirm: false },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("not found");
    });

    // ----- force_status -----

    describe("force_status", async () => {
      it("requires target_status", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handleEpicManage(
          { epic_id: "1.1", action: "force_status", cascade: false, confirm: false },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBe(true);
        expect(extractText(result)).toContain("target_status");
      });

      it("rejects invalid target_status", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handleEpicManage(
          {
            epic_id: "1.1",
            action: "force_status",
            target_status: "bogus",
            cascade: false,
            confirm: false,
          },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBe(true);
        expect(extractText(result)).toContain("Invalid target_status");
      });

      it("returns preview without mutating state", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handleEpicManage(
          {
            epic_id: "1.1",
            action: "force_status",
            target_status: "done",
            cascade: false,
            confirm: false,
          },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        const text = extractText(result);
        expect(text).toContain("force_status preview");
        expect(text).toContain("1.1");
        expect(text).toContain("Cascade to tasks: false");
        expect(stateManager.getEpic("1.1").status).toBe("pending");
      });

      it("applies force_status on confirm", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handleEpicManage(
          {
            epic_id: "1.1",
            action: "force_status",
            target_status: "done",
            cascade: false,
            confirm: true,
          },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        expect(extractText(result)).toContain('forced to "done"');
        expect(stateManager.getEpic("1.1").status).toBe("done");
        // Tasks should NOT be changed
        expect(stateManager.getTask("1.1.1").status).toBe("pending");
      });

      it("cascades force_status to all child tasks", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handleEpicManage(
          {
            epic_id: "1.1",
            action: "force_status",
            target_status: "done",
            cascade: true,
            confirm: true,
          },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        const text = extractText(result);
        expect(text).toContain('forced to "done"');
        expect(text).toContain("2 task(s) also updated");
        expect(stateManager.getEpic("1.1").status).toBe("done");
        expect(stateManager.getTask("1.1.1").status).toBe("done");
        expect(stateManager.getTask("1.1.2").status).toBe("done");
      });

      it("cascade preview lists each task transition", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handleEpicManage(
          {
            epic_id: "1.1",
            action: "force_status",
            target_status: "done",
            cascade: true,
            confirm: false,
          },
          stateManager,
          evidenceManager,
          tempDir,
        );

        const text = extractText(result);
        expect(text).toContain("Tasks affected: 2");
        expect(text).toContain("1.1.1");
        expect(text).toContain("1.1.2");
      });

      it("cleans task evidence on backward cascade", async () => {
        const state = makeCycleState();
        state.phases[0].epics[0].tasks[0].status = "done";
        state.phases[0].epics[0].tasks[1].status = "done";
        writeState(tempDir, state);

        evidenceManager.save({
          gate: "gate_0",
          entity_id: "1.1.1",
          passed: true,
          timestamp: new Date().toISOString(),
          checks: [],
        });

        await handleEpicManage(
          {
            epic_id: "1.1",
            action: "force_status",
            target_status: "pending",
            cascade: true,
            confirm: true,
          },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(evidenceManager.load("gate_0", "1.1.1")).toBeNull();
        expect(stateManager.getTask("1.1.1").status).toBe("pending");
      });
    });

    // ----- reset_tasks -----

    describe("reset_tasks", async () => {
      it("returns preview listing all tasks", async () => {
        const state = makeCycleState();
        state.phases[0].epics[0].tasks[0].status = "done";
        state.phases[0].epics[0].tasks[1].status = "failed";
        writeState(tempDir, state);

        const result = await handleEpicManage(
          { epic_id: "1.1", action: "reset_tasks", cascade: false, confirm: false },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        const text = extractText(result);
        expect(text).toContain("reset_tasks preview");
        expect(text).toContain("Tasks to reset: 2");
        expect(text).toContain("done -> pending");
        expect(text).toContain("failed -> pending");
      });

      it("resets all tasks to pending and clears evidence on confirm", async () => {
        const state = makeCycleState();
        state.phases[0].epics[0].tasks[0].status = "done";
        state.phases[0].epics[0].tasks[1].status = "failed";
        writeState(tempDir, state);

        evidenceManager.save({
          gate: "gate_0",
          entity_id: "1.1.1",
          passed: true,
          timestamp: new Date().toISOString(),
          checks: [],
        });
        evidenceManager.save({
          gate: "gate_0",
          entity_id: "1.1.2",
          passed: false,
          timestamp: new Date().toISOString(),
          checks: [],
        });
        evidenceManager.save({ gate: "gate_1", entity_id: "1.1.1", passed: true, timestamp: new Date().toISOString(), checks: [] });
        evidenceManager.save({ gate: "custom_post_task", entity_id: "1.1.2", passed: false, timestamp: new Date().toISOString(), checks: [] });
        evidenceManager.saveTerminalGate0Attempt({
          gate: "gate_0", entity_id: "1.1.1", passed: true, timestamp: new Date().toISOString(), checks: [],
          gate_0_attempt: { version: 1, id: "epic-reset-attempt", started_at: "2026-09-08T00:00:00.000Z", finished_at: "2026-09-08T00:01:00.000Z", outcome: "passed" },
        });
        evidenceManager.save({ gate: "gate_8", entity_id: "1.1", passed: true, timestamp: new Date().toISOString(), checks: [] });
        evidenceManager.save({ gate: "gate_9", entity_id: "1.1", passed: true, timestamp: new Date().toISOString(), checks: [] });

        const result = await handleEpicManage(
          { epic_id: "1.1", action: "reset_tasks", cascade: false, confirm: true },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        const text = extractText(result);
        expect(text).toContain('reset to "pending"');
        expect(text).toContain("5 evidence file(s) deleted");
        expect(stateManager.getTask("1.1.1").status).toBe("pending");
        expect(stateManager.getTask("1.1.2").status).toBe("pending");
        expect(evidenceManager.load("gate_0", "1.1.1")).toBeNull();
        expect(evidenceManager.load("gate_0", "1.1.2")).toBeNull();
        expect(evidenceManager.load("gate_1", "1.1.1")).toBeNull();
        expect(evidenceManager.load("custom_post_task", "1.1.2")).toBeNull();
        expect(existsSync(evidenceManager.attemptPathFor("1.1.1", "epic-reset-attempt"))).toBe(false);
        expect(evidenceManager.load("gate_8", "1.1")).not.toBeNull();
        expect(evidenceManager.load("gate_9", "1.1")).not.toBeNull();
      });
    });

    // ----- skip -----

    describe("skip", async () => {
      it("returns preview without mutating state", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handleEpicManage(
          { epic_id: "1.1", action: "skip", cascade: false, confirm: false },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        const text = extractText(result);
        expect(text).toContain("skip preview");
        expect(text).toContain("skipped");
        expect(stateManager.getEpic("1.1").status).toBe("pending");
      });

      it("transitions epic to skipped on confirm", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handleEpicManage(
          { epic_id: "1.1", action: "skip", cascade: false, confirm: true },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        expect(extractText(result)).toContain("skipped");
        expect(stateManager.getEpic("1.1").status).toBe("skipped");
        // Tasks should NOT be changed without cascade
        expect(stateManager.getTask("1.1.1").status).toBe("pending");
      });

      it("cascades skip to all child tasks", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handleEpicManage(
          { epic_id: "1.1", action: "skip", cascade: true, confirm: true },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        const text = extractText(result);
        expect(text).toContain("skipped");
        expect(text).toContain("2 task(s) also skipped");
        expect(stateManager.getEpic("1.1").status).toBe("skipped");
        expect(stateManager.getTask("1.1.1").status).toBe("skipped");
        expect(stateManager.getTask("1.1.2").status).toBe("skipped");
      });

      it("cascade skip preview shows task details", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handleEpicManage(
          { epic_id: "1.1", action: "skip", cascade: true, confirm: false },
          stateManager,
          evidenceManager,
          tempDir,
        );

        const text = extractText(result);
        expect(text).toContain("Tasks affected: 2");
        expect(text).toContain("1.1.1");
        expect(text).toContain("1.1.2");
      });

      it("rejects skip from already-skipped epic", async () => {
        const state = makeCycleState();
        state.phases[0].epics[0].status = "skipped";
        writeState(tempDir, state);

        const result = await handleEpicManage(
          { epic_id: "1.1", action: "skip", cascade: false, confirm: true },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBe(true);
        expect(extractText(result)).toContain("not allowed");
      });
    });
  });

  // -----------------------------------------------------------------------
  // phase_manage
  // -----------------------------------------------------------------------

  describe("phase_manage", async () => {
    it("returns error when no active cycle exists", async () => {
      const result = await handlePhaseManage(
        { phase_id: "1", action: "skip", confirm: false },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("No active cycle");
    });

    it("returns error for invalid (non-numeric) phase_id", async () => {
      writeState(tempDir, makeCycleState());

      const result = await handlePhaseManage(
        { phase_id: "abc", action: "skip", confirm: false },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("Invalid phase_id");
    });

    it("returns error when phase is not found", async () => {
      writeState(tempDir, makeCycleState());

      const result = await handlePhaseManage(
        { phase_id: "99", action: "skip", confirm: false },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("not found");
    });

    // ----- force_status -----

    describe("force_status", async () => {
      it("requires target_status", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handlePhaseManage(
          { phase_id: "1", action: "force_status", confirm: false },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBe(true);
        expect(extractText(result)).toContain("target_status");
      });

      it("rejects invalid target_status", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handlePhaseManage(
          {
            phase_id: "1",
            action: "force_status",
            target_status: "nope",
            confirm: false,
          },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBe(true);
        expect(extractText(result)).toContain("Invalid target_status");
      });

      it("returns preview without mutating state", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handlePhaseManage(
          {
            phase_id: "1",
            action: "force_status",
            target_status: "done",
            confirm: false,
          },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        const text = extractText(result);
        expect(text).toContain("force_status preview");
        expect(text).toContain("Phase: 1");
        expect(text).toContain("doing");
        expect(text).toContain("done");
        expect(stateManager.getPhase(1).status).toBe("doing");
      });

      it("applies force_status on confirm", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handlePhaseManage(
          {
            phase_id: "1",
            action: "force_status",
            target_status: "done",
            confirm: true,
          },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        expect(extractText(result)).toContain('forced from "doing" to "done"');
        expect(stateManager.getPhase(1).status).toBe("done");
      });
    });

    // ----- skip -----

    describe("skip", async () => {
      it("returns preview with full cascade details", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handlePhaseManage(
          { phase_id: "1", action: "skip", confirm: false },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        const text = extractText(result);
        expect(text).toContain("skip preview");
        expect(text).toContain("1 epic(s), 2 task(s) will also be skipped");
        expect(text).toContain("Epic 1.1");
        expect(text).toContain("Task 1.1.1");
        expect(text).toContain("Task 1.1.2");
        expect(text).toContain("confirm: true");
        // State unchanged
        expect(stateManager.getPhase(1).status).toBe("doing");
      });

      it("skips phase and all children on confirm", async () => {
        writeState(tempDir, makeCycleState());

        const result = await handlePhaseManage(
          { phase_id: "1", action: "skip", confirm: true },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        const text = extractText(result);
        expect(text).toContain("1 epic(s), 2 task(s)");
        expect(text).toContain("skipped");

        expect(stateManager.getPhase(1).status).toBe("skipped");
        expect(stateManager.getEpic("1.1").status).toBe("skipped");
        expect(stateManager.getTask("1.1.1").status).toBe("skipped");
        expect(stateManager.getTask("1.1.2").status).toBe("skipped");
      });

      it("skips multi-epic phase correctly", async () => {
        const state = makeCycleState();
        // Add a second epic with a task
        state.phases[0].epics.push({
          id: "1.2",
          name: "Second epic",
          status: "doing",
          tasks: [
            {
              id: "1.2.1",
              name: "Another task",
              status: "doing",
              gate_0: { passed: false },
            },
          ],
          gate_8: { passed: false },
          gate_9: { passed: false },
        });
        writeState(tempDir, state);

        const result = await handlePhaseManage(
          { phase_id: "1", action: "skip", confirm: true },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        const text = extractText(result);
        expect(text).toContain("2 epic(s), 3 task(s)");

        expect(stateManager.getPhase(1).status).toBe("skipped");
        expect(stateManager.getEpic("1.1").status).toBe("skipped");
        expect(stateManager.getEpic("1.2").status).toBe("skipped");
        expect(stateManager.getTask("1.1.1").status).toBe("skipped");
        expect(stateManager.getTask("1.1.2").status).toBe("skipped");
        expect(stateManager.getTask("1.2.1").status).toBe("skipped");
      });

      it("does not re-skip already-skipped children", async () => {
        const state = makeCycleState();
        // Pre-skip one task
        state.phases[0].epics[0].tasks[0].status = "skipped";
        writeState(tempDir, state);

        const result = await handlePhaseManage(
          { phase_id: "1", action: "skip", confirm: true },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        expect(stateManager.getPhase(1).status).toBe("skipped");
        expect(stateManager.getTask("1.1.1").status).toBe("skipped");
        expect(stateManager.getTask("1.1.2").status).toBe("skipped");
      });
    });
  });
});
