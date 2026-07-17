/**
 * Tests for task_start and task_complete tool handlers.
 *
 * Uses real temp directories with StateManager but mocks Gate 0 checks
 * and the executor (for git status in task_start).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "../../state/index.js";
import { DEFAULTS } from "../../config/index.js";
import type { RigorConfig } from "../../config/index.js";
import type { PhaseState } from "../../state/index.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../gates/index.js", () => ({
  checkGate0Exit: vi.fn(),
  checkGate1Exit: vi.fn().mockReturnValue({ passed: true, checks: [], skipped: true }),
  checkGate2Exit: vi.fn().mockReturnValue({ passed: true, checks: [], skipped: true }),
  checkGate3Exit: vi.fn().mockReturnValue({ passed: true, checks: [], skipped: true }),
  checkGate4Exit: vi.fn().mockReturnValue({ passed: true, checks: [], skipped: true }),
  checkGate5Exit: vi.fn().mockReturnValue({ passed: true, checks: [], skipped: true }),
  runCustomGates: vi.fn().mockReturnValue({ passed: true, checks: [] }),
}));

vi.mock("../../executor/index.js", () => ({
  runCommand: vi.fn().mockReturnValue({
    command: "git status --porcelain",
    exit_code: 0,
    stdout: "",
    stderr: "",
    duration_ms: 10,
    timed_out: false,
  }),
}));

const {
  checkGate0Exit,
  checkGate1Exit,
  checkGate2Exit,
  checkGate3Exit,
  checkGate4Exit,
  checkGate5Exit,
  runCustomGates,
} = await import("../../gates/index.js") as {
  checkGate0Exit: ReturnType<typeof vi.fn>;
  checkGate1Exit: ReturnType<typeof vi.fn>;
  checkGate2Exit: ReturnType<typeof vi.fn>;
  checkGate3Exit: ReturnType<typeof vi.fn>;
  checkGate4Exit: ReturnType<typeof vi.fn>;
  checkGate5Exit: ReturnType<typeof vi.fn>;
  runCustomGates: ReturnType<typeof vi.fn>;
};

const { handleTaskStart, handleTaskComplete } = await import("../gate.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TextContent {
  type: "text";
  text: string;
}

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0] as TextContent;
  return first.text;
}

function makePhases(): PhaseState[] {
  return [
    {
      id: 1,
      status: "pending",
      epics: [
        {
          id: "1.1",
          name: "Test epic",
          status: "pending",
          tasks: [
            {
              id: "1.1.1",
              name: "First task",
              status: "done",
              gate_0: { passed: false },
            },
            {
              id: "1.1.2",
              name: "Second task",
              status: "pending",
              gate_0: { passed: false },
            },
            {
              id: "1.1.3",
              name: "Third task",
              status: "pending",
              gate_0: { passed: false },
            },
          ],
          gate_8: { passed: false },
          gate_9: { passed: false },
        },
      ],
    },
  ];
}

const config: RigorConfig = DEFAULTS;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("gate tools", () => {
  let tempDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), "rigor-gate-tools-test-"));
    stateManager = new StateManager(tempDir);
    stateManager.init("test-plan.md", makePhases());
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // task_start
  // -----------------------------------------------------------------------

  describe("task_start", () => {
    // 1. Transitions pending task to doing
    it("transitions a pending task to doing", () => {
      const result = handleTaskStart(
        { task_id: "1.1.2" },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBeUndefined();
      const text = extractText(result);
      expect(text).toContain("Task 1.1.2 started");
      expect(text).toContain("Status: doing");

      const task = stateManager.getTask("1.1.2");
      expect(task.status).toBe("doing");
    });

    // 2. Rejects task not in pending/failed status
    it("rejects task that is already doing", () => {
      // First start it
      stateManager.transition("1.1.2", "doing");

      const result = handleTaskStart(
        { task_id: "1.1.2" },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text).toContain("doing");
      expect(text).toContain("Only");
    });

    // 3. Rejects when no cycle exists
    it("returns error when no cycle exists", () => {
      // Create a fresh state manager with no state
      const emptyDir = mkdtempSync(join(tmpdir(), "rigor-empty-"));
      const emptyManager = new StateManager(emptyDir);

      const result = handleTaskStart(
        { task_id: "1.1.1" },
        emptyManager,
        config,
        emptyDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("No active cycle");

      rmSync(emptyDir, { recursive: true, force: true });
    });

    // 4. Rejects when previous task is not done
    it("rejects when previous task in epic is not done", () => {
      // Task 1.1.3 cannot start because 1.1.2 is pending (not done)
      const result = handleTaskStart(
        { task_id: "1.1.3" },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text).toContain("1.1.2");
      expect(text).toContain("must be");
    });

    // 5. Allows retry of failed task
    it("allows starting a failed task (retry)", () => {
      stateManager.transition("1.1.2", "doing");
      stateManager.transition("1.1.2", "failed");

      const result = handleTaskStart(
        { task_id: "1.1.2" },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBeUndefined();
      const text = extractText(result);
      expect(text).toContain("Task 1.1.2 started");

      const task = stateManager.getTask("1.1.2");
      expect(task.status).toBe("doing");
    });

    // 6. Returns error for nonexistent task
    it("returns error for nonexistent task id", () => {
      const result = handleTaskStart(
        { task_id: "9.9.9" },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("not found");
    });

    // 7. Blocks when pre_task custom gate fails
    it("blocks when pre_task custom gate fails", () => {
      runCustomGates.mockReturnValueOnce({
        passed: false,
        checks: [
          {
            name: "custom:no-wip",
            passed: false,
            detail: 'Custom gate "no-wip" failed (exit code 1)',
          },
        ],
      });

      const result = handleTaskStart(
        { task_id: "1.1.2" },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text).toContain("blocked by custom pre_task gate");
      expect(text).toContain("[FAIL] custom:no-wip");

      // Task should still be pending (not transitioned)
      const task = stateManager.getTask("1.1.2");
      expect(task.status).toBe("pending");
    });

    // 8. Proceeds when pre_task custom gate passes
    it("proceeds when pre_task custom gate passes", () => {
      runCustomGates.mockReturnValueOnce({
        passed: true,
        checks: [
          {
            name: "custom:no-wip",
            passed: true,
            detail: 'Custom gate "no-wip" passed',
          },
        ],
      });

      const result = handleTaskStart(
        { task_id: "1.1.2" },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBeUndefined();
      const text = extractText(result);
      expect(text).toContain("Task 1.1.2 started");
      expect(text).toContain("Status: doing");

      const task = stateManager.getTask("1.1.2");
      expect(task.status).toBe("doing");
    });

    // 9. Task starts normally when Gate 1 is triggered and passes
    it("starts task when Gate 1 is triggered and passes", () => {
      checkGate1Exit.mockReturnValueOnce({
        passed: true,
        checks: [
          { name: "dependency_changes", passed: true, detail: "Changed files: package.json" },
          { name: "audit", passed: true, detail: "Infrastructure audit passed" },
        ],
        skipped: false,
      });

      const result = handleTaskStart(
        { task_id: "1.1.2" },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBeUndefined();
      const text = extractText(result);
      expect(text).toContain("Task 1.1.2 started");
      expect(text).toContain("Status: doing");

      const task = stateManager.getTask("1.1.2");
      expect(task.status).toBe("doing");
    });

    // 10. Task blocked when Gate 1 is triggered and fails
    it("blocks task when Gate 1 is triggered and fails", () => {
      checkGate1Exit.mockReturnValueOnce({
        passed: false,
        checks: [
          { name: "dependency_changes", passed: true, detail: "Changed files: package.json" },
          { name: "audit", passed: false, detail: "Infrastructure audit failed (exit code 1)" },
        ],
        skipped: false,
      });

      const result = handleTaskStart(
        { task_id: "1.1.2" },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text).toContain("blocked by Gate 1");
      expect(text).toContain("[PASS] dependency_changes");
      expect(text).toContain("[FAIL] audit");

      // Task should still be pending (not transitioned)
      const task = stateManager.getTask("1.1.2");
      expect(task.status).toBe("pending");
    });
  });

  // -----------------------------------------------------------------------
  // task_complete
  // -----------------------------------------------------------------------

  describe("task_complete", () => {
    beforeEach(() => {
      // Put task 1.1.2 into "doing" so it can be completed
      stateManager.transition("1.1.2", "doing");
    });

    // 3. Runs gate 0 checks and transitions to done on pass
    it("transitions to done when gate 0 passes", async () => {
      checkGate0Exit.mockResolvedValue({
        passed: true,
        checks: [
          { name: "tests", passed: true, detail: "All tests passed" },
        ],
        coverage: 92,
      });

      const result = await handleTaskComplete(
        { task_id: "1.1.2" },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBeUndefined();
      const text = extractText(result);
      expect(text).toContain("completed successfully");
      expect(text).toContain("[PASS] tests");

      const task = stateManager.getTask("1.1.2");
      expect(task.status).toBe("done");
    });

    // 4. Transitions to failed on gate 0 failure
    it("transitions to failed when gate 0 fails", async () => {
      checkGate0Exit.mockResolvedValue({
        passed: false,
        checks: [
          { name: "tests", passed: false, detail: "Tests failed (exit code 1)" },
        ],
      });

      const result = await handleTaskComplete(
        { task_id: "1.1.2" },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text).toContain("failed Gate 0");
      expect(text).toContain("[FAIL] tests");

      const task = stateManager.getTask("1.1.2");
      expect(task.status).toBe("failed");
    });

    // 5. Saves evidence
    it("saves gate evidence to disk", async () => {
      checkGate0Exit.mockResolvedValue({
        passed: true,
        checks: [
          { name: "tests", passed: true, detail: "All tests passed" },
        ],
      });

      const result = await handleTaskComplete(
        { task_id: "1.1.2" },
        stateManager,
        config,
        tempDir,
      );

      const text = extractText(result);
      expect(text).toContain("Evidence:");
      expect(text).toContain("gate_0-task-1.1.2.json");

      // Check gate_0 field was updated in state
      const task = stateManager.getTask("1.1.2");
      expect(task.gate_0.passed).toBe(true);
      expect(task.gate_0.evidence_path).toBeDefined();
      expect(task.gate_0.tests_passed).toBe(true);
    });

    // 6. Rejects task not in "doing" status
    it("rejects task not in doing status", async () => {
      const result = await handleTaskComplete(
        { task_id: "1.1.3" },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("pending");
      expect(extractText(result)).toContain("Only");
    });

    // 7. Returns error when no cycle exists
    it("returns error when no cycle exists", async () => {
      const emptyDir = mkdtempSync(join(tmpdir(), "rigor-empty-"));
      const emptyManager = new StateManager(emptyDir);

      const result = await handleTaskComplete(
        { task_id: "1.1.1" },
        emptyManager,
        config,
        emptyDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("No active cycle");

      rmSync(emptyDir, { recursive: true, force: true });
    });

    // 8. Transitions to failed when post_task custom gate fails
    it("transitions to failed when post_task custom gate fails", async () => {
      checkGate0Exit.mockResolvedValue({
        passed: true,
        checks: [
          { name: "tests", passed: true, detail: "All tests passed" },
        ],
        coverage: 90,
      });

      runCustomGates.mockReturnValueOnce({
        passed: false,
        checks: [
          {
            name: "custom:security-scan",
            passed: false,
            detail: 'Custom gate "security-scan" failed (exit code 1)',
          },
        ],
      });

      const result = await handleTaskComplete(
        { task_id: "1.1.2" },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text).toContain("passed Gate 0 but failed post_task custom gate");
      expect(text).toContain("[PASS] tests");
      expect(text).toContain("[FAIL] custom:security-scan");

      // Task should be "failed"
      const task = stateManager.getTask("1.1.2");
      expect(task.status).toBe("failed");
    });

    // 9. Proceeds when post_task custom gate passes
    it("proceeds when post_task custom gate passes", async () => {
      checkGate0Exit.mockResolvedValue({
        passed: true,
        checks: [
          { name: "tests", passed: true, detail: "All tests passed" },
        ],
        coverage: 90,
      });

      runCustomGates.mockReturnValueOnce({
        passed: true,
        checks: [
          {
            name: "custom:security-scan",
            passed: true,
            detail: 'Custom gate "security-scan" passed',
          },
        ],
      });

      const result = await handleTaskComplete(
        { task_id: "1.1.2" },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBeUndefined();
      const text = extractText(result);
      expect(text).toContain("completed successfully");

      const task = stateManager.getTask("1.1.2");
      expect(task.status).toBe("done");
    });
  });
});
