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
});
