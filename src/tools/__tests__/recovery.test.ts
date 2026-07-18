/**
 * Tests for cycle_reset, task_retry, and cycle_diagnose tool handlers.
 *
 * Each test gets a fresh temp directory so state files don't collide.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { StateManager } from "../../state/index.js";
import { EvidenceManager } from "../../evidence/index.js";
import type { GateEvidence } from "../../evidence/index.js";
import {
  handleCycleReset,
  handleTaskRetry,
  handleTaskManage,
  handleEpicManage,
  handlePhaseManage,
  handleCycleDiagnose,
} from "../recovery.js";
import type { CycleState } from "../../state/index.js";

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

  describe("cycle_reset", () => {
    it("returns error when no active cycle exists", () => {
      const result = handleCycleReset(
        { confirm: false },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text).toContain("No active cycle");
    });

    it("returns preview with progress summary when confirm is false", () => {
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

      const result = handleCycleReset(
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

    it("deletes state and evidence when confirm is true", () => {
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

      const result = handleCycleReset(
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
  // task_retry
  // -----------------------------------------------------------------------

  describe("task_retry", () => {
    it("returns error when no active cycle exists", () => {
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

    it("returns error when task is not found", () => {
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

    it("rejects task not in failed status", () => {
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

    it("clears gate_0 evidence and returns previous failure reason", () => {
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
      });

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

      // Verify evidence file was deleted
      expect(existsSync(evidencePath)).toBe(false);

      // Verify gate_0 was reset in state
      const updatedState = stateManager.load();
      const task = updatedState?.phases[0].epics[0].tasks[0];
      expect(task?.gate_0.passed).toBe(false);
      expect(task?.gate_0.evidence_path).toBeUndefined();
    });

    it("handles failed task with no prior evidence gracefully", () => {
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

  describe("cycle_diagnose", () => {
    it("returns no active cycle when no state exists", () => {
      const result = handleCycleDiagnose(
        stateManager,
        evidenceManager,
        tempDir,
      );

      const text = extractText(result);
      expect(text).toContain("No active cycle");
    });

    it("reports healthy status when all is valid", () => {
      const state = makeCycleState();
      writeState(tempDir, state);

      const result = handleCycleDiagnose(
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

    it("reports degraded status when stuck entities exist", () => {
      const state = makeCycleState();
      // A task stuck in "doing"
      state.phases[0].epics[0].tasks[0].status = "doing";
      writeState(tempDir, state);

      const result = handleCycleDiagnose(
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

    it("reports corrupt status when validation errors exist", () => {
      // Create a state with an invalid current_phase
      const state = makeCycleState();
      state.current_phase = 999;
      writeState(tempDir, state);

      const result = handleCycleDiagnose(
        stateManager,
        evidenceManager,
        tempDir,
      );

      const text = extractText(result);
      expect(text).toContain("Health: corrupt");
      expect(text).toContain("[ERROR]");
      expect(text).toContain("current_phase");
    });

    it("detects missing evidence for done tasks", () => {
      const state = makeCycleState();
      // Mark task as done but don't create evidence
      state.phases[0].epics[0].tasks[0].status = "done";
      state.phases[0].epics[0].tasks[0].gate_0 = { passed: true };
      writeState(tempDir, state);

      const result = handleCycleDiagnose(
        stateManager,
        evidenceManager,
        tempDir,
      );

      const text = extractText(result);
      expect(text).toContain("Evidence audit: 1 missing");
      expect(text).toContain("Task 1.1.1: missing gate_0 evidence");
    });

    it("detects missing evidence for done epics", () => {
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
      const result = handleCycleDiagnose(
        stateManager,
        evidenceManager,
        tempDir,
      );

      const text = extractText(result);
      expect(text).toContain("Evidence audit: 2 missing");
      expect(text).toContain("Epic 1.1: missing gate_8 evidence");
      expect(text).toContain("Epic 1.1: missing gate_9 evidence");
    });
  });

  // -----------------------------------------------------------------------
  // task_manage
  // -----------------------------------------------------------------------

  describe("task_manage", () => {
    it("returns error when no active cycle exists", () => {
      const result = handleTaskManage(
        { task_id: "1.1.1", action: "skip", confirm: false },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("No active cycle");
    });

    it("returns error when task is not found", () => {
      writeState(tempDir, makeCycleState());

      const result = handleTaskManage(
        { task_id: "9.9.9", action: "skip", confirm: false },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("not found");
    });

    // ----- force_status -----

    describe("force_status", () => {
      it("requires target_status parameter", () => {
        writeState(tempDir, makeCycleState());

        const result = handleTaskManage(
          { task_id: "1.1.1", action: "force_status", confirm: false },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBe(true);
        expect(extractText(result)).toContain("target_status");
      });

      it("rejects invalid target_status", () => {
        writeState(tempDir, makeCycleState());

        const result = handleTaskManage(
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

      it("returns preview without mutating state", () => {
        writeState(tempDir, makeCycleState());

        const result = handleTaskManage(
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

      it("applies force_status on confirm", () => {
        writeState(tempDir, makeCycleState());

        const result = handleTaskManage(
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

      it("clears evidence on backward transition (done -> pending)", () => {
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
        const preview = handleTaskManage(
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
        const result = handleTaskManage(
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

      it("preserves evidence on forward transition", () => {
        writeState(tempDir, makeCycleState());

        evidenceManager.save({
          gate: "gate_0",
          entity_id: "1.1.1",
          passed: true,
          timestamp: new Date().toISOString(),
          checks: [],
        });

        // Preview should mention evidence preserved
        const preview = handleTaskManage(
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

        handleTaskManage(
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

    describe("skip", () => {
      it("returns preview without mutating state", () => {
        writeState(tempDir, makeCycleState());

        const result = handleTaskManage(
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

      it("transitions task to skipped on confirm", () => {
        writeState(tempDir, makeCycleState());

        const result = handleTaskManage(
          { task_id: "1.1.1", action: "skip", confirm: true },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        expect(extractText(result)).toContain("skipped");
        expect(stateManager.getTask("1.1.1").status).toBe("skipped");
      });

      it("rejects skip from already-skipped status", () => {
        const state = makeCycleState();
        state.phases[0].epics[0].tasks[0].status = "skipped";
        writeState(tempDir, state);

        const result = handleTaskManage(
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

    describe("retry", () => {
      it("returns error preview for non-failed tasks", () => {
        writeState(tempDir, makeCycleState());

        const result = handleTaskManage(
          { task_id: "1.1.1", action: "retry", confirm: false },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBe(true);
        expect(extractText(result)).toContain("pending");
        expect(extractText(result)).toContain("Only \"failed\"");
      });

      it("returns preview for failed tasks with evidence info", () => {
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

        const result = handleTaskManage(
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

      it("delegates to handleTaskRetry on confirm", () => {
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

        const result = handleTaskManage(
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

    describe("reset_evidence", () => {
      it("returns preview showing what evidence exists", () => {
        writeState(tempDir, makeCycleState());

        evidenceManager.save({
          gate: "gate_0",
          entity_id: "1.1.1",
          passed: true,
          timestamp: new Date().toISOString(),
          checks: [],
        });

        const result = handleTaskManage(
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

      it("returns preview showing no evidence when none exists", () => {
        writeState(tempDir, makeCycleState());

        const result = handleTaskManage(
          { task_id: "1.1.1", action: "reset_evidence", confirm: false },
          stateManager,
          evidenceManager,
          tempDir,
        );

        const text = extractText(result);
        expect(text).toContain("none");
      });

      it("deletes all evidence without changing status on confirm", () => {
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

        const result = handleTaskManage(
          { task_id: "1.1.1", action: "reset_evidence", confirm: true },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        const text = extractText(result);
        expect(text).toContain("1 file(s) deleted");
        expect(text).toContain("Status unchanged (done)");
        expect(evidenceManager.load("gate_0", "1.1.1")).toBeNull();
        expect(stateManager.getTask("1.1.1").status).toBe("done");
      });
    });
  });

  // -----------------------------------------------------------------------
  // epic_manage
  // -----------------------------------------------------------------------

  describe("epic_manage", () => {
    it("returns error when no active cycle exists", () => {
      const result = handleEpicManage(
        { epic_id: "1.1", action: "skip", cascade: false, confirm: false },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("No active cycle");
    });

    it("returns error when epic is not found", () => {
      writeState(tempDir, makeCycleState());

      const result = handleEpicManage(
        { epic_id: "9.9", action: "skip", cascade: false, confirm: false },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("not found");
    });

    // ----- force_status -----

    describe("force_status", () => {
      it("requires target_status", () => {
        writeState(tempDir, makeCycleState());

        const result = handleEpicManage(
          { epic_id: "1.1", action: "force_status", cascade: false, confirm: false },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBe(true);
        expect(extractText(result)).toContain("target_status");
      });

      it("rejects invalid target_status", () => {
        writeState(tempDir, makeCycleState());

        const result = handleEpicManage(
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

      it("returns preview without mutating state", () => {
        writeState(tempDir, makeCycleState());

        const result = handleEpicManage(
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

      it("applies force_status on confirm", () => {
        writeState(tempDir, makeCycleState());

        const result = handleEpicManage(
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

      it("cascades force_status to all child tasks", () => {
        writeState(tempDir, makeCycleState());

        const result = handleEpicManage(
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

      it("cascade preview lists each task transition", () => {
        writeState(tempDir, makeCycleState());

        const result = handleEpicManage(
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

      it("cleans task evidence on backward cascade", () => {
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

        handleEpicManage(
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

    describe("reset_tasks", () => {
      it("returns preview listing all tasks", () => {
        const state = makeCycleState();
        state.phases[0].epics[0].tasks[0].status = "done";
        state.phases[0].epics[0].tasks[1].status = "failed";
        writeState(tempDir, state);

        const result = handleEpicManage(
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

      it("resets all tasks to pending and clears evidence on confirm", () => {
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

        const result = handleEpicManage(
          { epic_id: "1.1", action: "reset_tasks", cascade: false, confirm: true },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBeUndefined();
        const text = extractText(result);
        expect(text).toContain('reset to "pending"');
        expect(text).toContain("2 evidence file(s) deleted");
        expect(stateManager.getTask("1.1.1").status).toBe("pending");
        expect(stateManager.getTask("1.1.2").status).toBe("pending");
        expect(evidenceManager.load("gate_0", "1.1.1")).toBeNull();
        expect(evidenceManager.load("gate_0", "1.1.2")).toBeNull();
      });
    });

    // ----- skip -----

    describe("skip", () => {
      it("returns preview without mutating state", () => {
        writeState(tempDir, makeCycleState());

        const result = handleEpicManage(
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

      it("transitions epic to skipped on confirm", () => {
        writeState(tempDir, makeCycleState());

        const result = handleEpicManage(
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

      it("cascades skip to all child tasks", () => {
        writeState(tempDir, makeCycleState());

        const result = handleEpicManage(
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

      it("cascade skip preview shows task details", () => {
        writeState(tempDir, makeCycleState());

        const result = handleEpicManage(
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

      it("rejects skip from already-skipped epic", () => {
        const state = makeCycleState();
        state.phases[0].epics[0].status = "skipped";
        writeState(tempDir, state);

        const result = handleEpicManage(
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

  describe("phase_manage", () => {
    it("returns error when no active cycle exists", () => {
      const result = handlePhaseManage(
        { phase_id: "1", action: "skip", confirm: false },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("No active cycle");
    });

    it("returns error for invalid (non-numeric) phase_id", () => {
      writeState(tempDir, makeCycleState());

      const result = handlePhaseManage(
        { phase_id: "abc", action: "skip", confirm: false },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("Invalid phase_id");
    });

    it("returns error when phase is not found", () => {
      writeState(tempDir, makeCycleState());

      const result = handlePhaseManage(
        { phase_id: "99", action: "skip", confirm: false },
        stateManager,
        evidenceManager,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("not found");
    });

    // ----- force_status -----

    describe("force_status", () => {
      it("requires target_status", () => {
        writeState(tempDir, makeCycleState());

        const result = handlePhaseManage(
          { phase_id: "1", action: "force_status", confirm: false },
          stateManager,
          evidenceManager,
          tempDir,
        );

        expect(result.isError).toBe(true);
        expect(extractText(result)).toContain("target_status");
      });

      it("rejects invalid target_status", () => {
        writeState(tempDir, makeCycleState());

        const result = handlePhaseManage(
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

      it("returns preview without mutating state", () => {
        writeState(tempDir, makeCycleState());

        const result = handlePhaseManage(
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

      it("applies force_status on confirm", () => {
        writeState(tempDir, makeCycleState());

        const result = handlePhaseManage(
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

    describe("skip", () => {
      it("returns preview with full cascade details", () => {
        writeState(tempDir, makeCycleState());

        const result = handlePhaseManage(
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

      it("skips phase and all children on confirm", () => {
        writeState(tempDir, makeCycleState());

        const result = handlePhaseManage(
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

      it("skips multi-epic phase correctly", () => {
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

        const result = handlePhaseManage(
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

      it("does not re-skip already-skipped children", () => {
        const state = makeCycleState();
        // Pre-skip one task
        state.phases[0].epics[0].tasks[0].status = "skipped";
        writeState(tempDir, state);

        const result = handlePhaseManage(
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
