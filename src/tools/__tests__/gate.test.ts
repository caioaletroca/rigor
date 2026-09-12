/**
 * Tests for task_start and task_complete tool handlers.
 *
 * Uses real temp directories with StateManager but mocks Gate 0 checks
 * and the executor (for git status in task_start).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "../../state/index.js";
import { EvidenceManager } from "../../evidence/index.js";
import { DEFAULTS } from "../../config/index.js";
import type { RigorConfig } from "../../config/index.js";
import type { PhaseState } from "../../state/index.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../gates/index.js", () => ({
  checkGate0Exit: vi.fn(),
  checkGate1Exit: vi.fn().mockResolvedValue({ passed: true, checks: [], skipped: true }),
  runCustomGates: vi.fn().mockResolvedValue({ passed: true, checks: [] }),
}));

vi.mock("../../executor/index.js", () => ({
  runCommand: vi.fn().mockResolvedValue({
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
  runCustomGates,
} = await import("../../gates/index.js") as {
  checkGate0Exit: ReturnType<typeof vi.fn>;
  checkGate1Exit: ReturnType<typeof vi.fn>;
  runCustomGates: ReturnType<typeof vi.fn>;
};

const { handleTaskStart, handleTaskComplete, handleTaskRenew } = await import("../../services/task-lifecycle.js");
const { registerGateTools } = await import("../gate.js");
const { handleCycleStatus } = await import("../cycle.js");
const { handleCycleDiagnose, handleCycleReset, handleTaskRetry } = await import("../../services/recovery-lifecycle.js");

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

describe("gate tools", async () => {
  it("registers the task lifecycle MCP schemas", () => {
    const tool = vi.fn();

    registerGateTools({ tool } as never, {} as StateManager, "C:/project");

    expect(tool.mock.calls.map(([name]) => name)).toEqual(["task_start", "task_renew", "task_complete"]);
    expect(tool.mock.calls[0][2].owner_id.safeParse("").success).toBe(false);
    expect(tool.mock.calls[2][2].attempt_id.safeParse("").success).toBe(false);
  });

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

  describe("task_start", async () => {
    // 1. Transitions pending task to doing
    it("transitions a pending task to doing", async () => {
      const result = await handleTaskStart(
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
    it("rejects task that is already doing", async () => {
      // First start it
      stateManager.transition("1.1.2", "doing");

      const result = await handleTaskStart(
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

    it("grants a new lease when taking over an expired lease", async () => {
      await handleTaskStart(
        { task_id: "1.1.2", owner_id: "owner-a" },
        stateManager,
        config,
        tempDir,
      );
      const originalLease = stateManager.getTask("1.1.2").lease!;

      const state = stateManager.load()!;
      const expiring = state.phases[0].epics[0].tasks.find((t) => t.id === "1.1.2")!;
      expiring.lease!.lease_expires_at = new Date(Date.now() - 1000).toISOString();
      stateManager.save(state);

      const result = await handleTaskStart(
        { task_id: "1.1.2", owner_id: "owner-b", takeover: true },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBeUndefined();
      expect(extractText(result)).toContain("Task 1.1.2 started");

      const task = stateManager.getTask("1.1.2");
      expect(task.status).toBe("doing");
      expect(task.lease?.owner_id).toBe("owner-b");
      expect(task.lease?.attempt_id).not.toBe(originalLease.attempt_id);
      expect(Date.parse(task.lease!.lease_expires_at)).toBeGreaterThan(Date.now());
      expect(task.lease?.takeover_history).toHaveLength(1);
      expect(task.lease?.takeover_history?.[0].owner_id).toBe("owner-a");
      expect(task.lease?.takeover_history?.[0].taken_over_at).toBeDefined();
    });

    it("rejects a competing takeover after the first takeover issues a live lease", async () => {
      await handleTaskStart(
        { task_id: "1.1.2", owner_id: "owner-a" },
        stateManager,
        config,
        tempDir,
      );
      const state = stateManager.load()!;
      const expiring = state.phases[0].epics[0].tasks.find((t) => t.id === "1.1.2")!;
      expiring.lease!.lease_expires_at = new Date(Date.now() - 1000).toISOString();
      stateManager.save(state);

      const [first, second] = await Promise.all([
        handleTaskStart(
          { task_id: "1.1.2", owner_id: "owner-b", takeover: true },
          stateManager,
          config,
          tempDir,
        ),
        handleTaskStart(
          { task_id: "1.1.2", owner_id: "owner-c", takeover: true },
          stateManager,
          config,
          tempDir,
        ),
      ]);

      expect(first.isError).toBeUndefined();
      expect(second.isError).toBe(true);
      expect(extractText(second)).toContain('owned by "owner-b"');
      expect(stateManager.getTask("1.1.2").lease?.owner_id).toBe("owner-b");
    });

    // 3. Rejects when no cycle exists
    it("returns error when no cycle exists", async () => {
      // Create a fresh state manager with no state
      const emptyDir = mkdtempSync(join(tmpdir(), "rigor-empty-"));
      const emptyManager = new StateManager(emptyDir);

      const result = await handleTaskStart(
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
    it("rejects when previous task in epic is not done", async () => {
      // Task 1.1.3 cannot start because 1.1.2 is pending (not done)
      const result = await handleTaskStart(
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
    it("allows starting a failed task (retry)", async () => {
      stateManager.transition("1.1.2", "doing");
      stateManager.transition("1.1.2", "failed");

      const result = await handleTaskStart(
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
    it("returns error for nonexistent task id", async () => {
      const result = await handleTaskStart(
        { task_id: "9.9.9" },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("not found");
    });

    // 7. Blocks when pre_task custom gate fails
    it("blocks when pre_task custom gate fails", async () => {
      runCustomGates.mockResolvedValueOnce({
        passed: false,
        checks: [
          {
            name: "custom:no-wip",
            passed: false,
            detail: 'Custom gate "no-wip" failed (exit code 1)',
          },
        ],
      });

      const result = await handleTaskStart(
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
    it("proceeds when pre_task custom gate passes", async () => {
      runCustomGates.mockResolvedValueOnce({
        passed: true,
        checks: [
          {
            name: "custom:no-wip",
            passed: true,
            detail: 'Custom gate "no-wip" passed',
          },
        ],
      });

      const result = await handleTaskStart(
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
    it("starts task when Gate 1 is triggered and passes", async () => {
      checkGate1Exit.mockResolvedValueOnce({
        passed: true,
        checks: [
          { name: "dependency_changes", passed: true, detail: "Changed files: package.json" },
          { name: "audit", passed: true, detail: "Infrastructure audit passed" },
        ],
        skipped: false,
      });

      const result = await handleTaskStart(
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
    it("blocks task when Gate 1 is triggered and fails", async () => {
      checkGate1Exit.mockResolvedValueOnce({
        passed: false,
        checks: [
          { name: "dependency_changes", passed: true, detail: "Changed files: package.json" },
          { name: "audit", passed: false, detail: "Infrastructure audit failed (exit code 1)" },
        ],
        skipped: false,
      });

      const result = await handleTaskStart(
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
  // task_renew
  // -----------------------------------------------------------------------

  describe("task_renew", () => {
    async function startLease() {
      await handleTaskStart({ task_id: "1.1.2", owner_id: "owner-a" }, stateManager, config, tempDir);
      return stateManager.getTask("1.1.2").lease!;
    }

    it("renews only the matching live owner and attempt", async () => {
      const lease = await startLease();
      const before = Date.parse(lease.lease_expires_at);

      const result = await handleTaskRenew(
        { task_id: "1.1.2", owner_id: lease.owner_id, attempt_id: lease.attempt_id },
        stateManager,
        tempDir,
      );

      expect(result.isError).toBeUndefined();
      expect(extractText(result)).toContain("lease renewed");
      expect(Date.parse(stateManager.getTask("1.1.2").lease!.lease_expires_at)).toBeGreaterThanOrEqual(before);
    });

    it("rejects a stale owner or attempt without changing its replacement", async () => {
      const lease = await startLease();
      const state = stateManager.load()!;
      const task = state.phases[0].epics[0].tasks.find((candidate) => candidate.id === "1.1.2")!;
      task.lease = { owner_id: "owner-b", attempt_id: "attempt-b", lease_expires_at: new Date(Date.now() + 60_000).toISOString() };
      stateManager.save(state);
      const before = stateManager.getTask("1.1.2").lease;

      const result = await handleTaskRenew(
        { task_id: "1.1.2", owner_id: lease.owner_id, attempt_id: lease.attempt_id },
        stateManager,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("not renewed");
      expect(stateManager.getTask("1.1.2").lease).toEqual(before);
    });

    it("serializes an expired renewal and takeover so the takeover keeps the lease", async () => {
      const lease = await startLease();
      const state = stateManager.load()!;
      state.phases[0].epics[0].tasks.find((candidate) => candidate.id === "1.1.2")!.lease!.lease_expires_at = new Date(Date.now() - 1).toISOString();
      stateManager.save(state);

      const [renewal, takeover] = await Promise.all([
        handleTaskRenew({ task_id: "1.1.2", owner_id: lease.owner_id, attempt_id: lease.attempt_id }, stateManager, tempDir),
        handleTaskStart({ task_id: "1.1.2", owner_id: "owner-b", takeover: true }, stateManager, config, tempDir),
      ]);

      expect(renewal.isError).toBe(true);
      expect(takeover.isError).toBeUndefined();
      expect(stateManager.getTask("1.1.2").lease).toMatchObject({ owner_id: "owner-b" });
    });

    it("reports missing cycles and tasks as errors", async () => {
      const empty = new StateManager(join(tempDir, "empty"));
      const noCycle = await handleTaskRenew({ task_id: "1.1.2", owner_id: "owner-a", attempt_id: "attempt-a" }, empty, tempDir);
      const noTask = await handleTaskRenew({ task_id: "9.9.9", owner_id: "owner-a", attempt_id: "attempt-a" }, stateManager, tempDir);

      expect(noCycle.isError).toBe(true);
      expect(noTask.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // task_complete
  // -----------------------------------------------------------------------

  describe("task_complete", async () => {
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

    it("saves in-progress evidence before awaiting Gate 0", async () => {
      let resolveGate!: (value: { passed: boolean; checks: Array<{ name: string; passed: boolean; detail: string }> }) => void;
      checkGate0Exit.mockImplementationOnce(() => new Promise((resolve) => {
        resolveGate = resolve;
      }));

      const completion = handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);
      await vi.waitFor(() => expect(checkGate0Exit).toHaveBeenCalledTimes(1));
      const evidence = JSON.parse(readFileSync(join(tempDir, ".rigor", "evidence", "gate_0-task-1.1.2.json"), "utf-8"));

       expect(evidence.gate_0_attempt).toMatchObject({ version: 1 });
       expect(evidence.gate_0_attempt.finished_at).toBeUndefined();
       expect(stateManager.getTask("1.1.2").status).toBe("doing");
       expect(stateManager.getTask("1.1.2").gate_0.evidence_path).toBe(join(tempDir, ".rigor", "evidence", "gate_0-task-1.1.2.json"));


      resolveGate({
        passed: true,
        checks: [{ name: "tests", passed: true, detail: "All tests passed" }],
      });

      await completion;
    });

    it("cleans up and fails recoverably when initial attempt persistence fails", async () => {
      const save = vi.spyOn(EvidenceManager.prototype, "save").mockImplementationOnce(() => {
        throw new Error("initial evidence write failed");
      });

      const result = await handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("failed while initializing or persisting");
      expect(stateManager.getTask("1.1.2").status).toBe("failed");

      stateManager.transition("1.1.2", "doing");
      checkGate0Exit.mockResolvedValueOnce({
        passed: true,
        checks: [{ name: "tests", passed: true, detail: "All tests passed" }],
      });
      const retry = await handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);

      expect(extractText(retry)).toContain("completed successfully");
      save.mockRestore();
    });

    it("persists callback-driven live progress and replaces it with terminal evidence", async () => {
      let resolveGate!: (value: { passed: boolean; checks: Array<{ name: string; passed: boolean; detail: string }> }) => void;
      checkGate0Exit.mockImplementationOnce((_taskId, _config, _projectRoot, options) => {
        options.onCheckStart({
          check_name: "test_files",
          command: "git status --porcelain",
        });
        return new Promise((resolve) => {
          resolveGate = resolve;
        });
      });

       const completion = handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);
       await vi.waitFor(() => expect(checkGate0Exit).toHaveBeenCalledTimes(1));
       const evidencePath = join(tempDir, ".rigor", "evidence", "gate_0-task-1.1.2.json");
       await vi.waitFor(() => expect(JSON.parse(readFileSync(evidencePath, "utf-8")).gate_0_attempt.current_check).toBeDefined());
       const liveEvidence = JSON.parse(readFileSync(evidencePath, "utf-8"));

      expect(liveEvidence.gate_0_attempt).toMatchObject({
        current_check: {
          check_name: "test_files",
          command: "git status --porcelain",
        },
      });
      expect(liveEvidence.gate_0_attempt.finished_at).toBeUndefined();

      resolveGate({
        passed: true,
        checks: [{ name: "test_files", passed: true, detail: "No new source files requiring tests" }],
      });
      await completion;

      const terminalEvidence = JSON.parse(readFileSync(evidencePath, "utf-8"));
      expect(terminalEvidence.gate_0_attempt.finished_at).toBeDefined();
      expect(terminalEvidence.gate_0_attempt.current_check).toBeUndefined();
    });

    it("reports a live Gate 0 attempt over an earlier stale doing task", async () => {
      const state = stateManager.load()!;
      state.phases[0].epics[0].tasks[0].status = "doing";
      stateManager.save(state);
      let resolveGate!: (value: { passed: boolean; checks: Array<{ name: string; passed: boolean; detail: string }> }) => void;
      checkGate0Exit.mockImplementationOnce((_taskId, _config, _projectRoot, options) => {
        options.onCheckStart({ check_name: "tests", command: "npm test", configured_timeout_ms: 5_000 });
        return new Promise((resolve) => {
          resolveGate = resolve;
        });
      });

      const completion = handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);
      const evidenceManager = new EvidenceManager(tempDir);
      const evidencePath = join(tempDir, ".rigor", "evidence", "gate_0-task-1.1.2.json");
      await vi.waitFor(() => expect(JSON.parse(readFileSync(evidencePath, "utf-8")).gate_0_attempt.current_check).toBeDefined());
      const liveStatus = extractText(handleCycleStatus(stateManager, evidenceManager, tempDir));
      const liveDiagnose = extractText(await handleCycleDiagnose(stateManager, evidenceManager, tempDir));

       const liveEvidence = readFileSync(evidencePath, "utf-8");
       expect(liveStatus).toContain("Active Task: 1.1.2 Second task");
       expect(liveStatus).toMatch(/Gate 0: executing tests \(\d+ms elapsed, timeout: 5000ms\)/);
       expect(liveStatus).toContain(`Evidence: ${evidencePath}`);
       expect(liveDiagnose).toContain("Executing Gate 0 attempts:");
       expect(liveDiagnose).toContain("task 1.1.1 (First task)");
       expect(liveDiagnose).toMatch(/task 1\.1\.2 \(Second task\): tests \(\d+ms elapsed, timeout: 5000ms\)/);
        expect(liveDiagnose).toContain(`Evidence: ${evidencePath}`);
        expect(liveDiagnose).not.toContain('task_manage({ task_id: "1.1.2", action: "retry", confirm: true })');
        expect(liveDiagnose).not.toContain('task_manage({ task_id: "1.1.2", action: "reset_evidence", confirm: true })');
        expect(stateManager.getTask("1.1.2").status).toBe("doing");
        expect(readFileSync(evidencePath, "utf-8")).toBe(liveEvidence);

       resolveGate({
        passed: true,
        checks: [{ name: "tests", passed: true, detail: "All tests passed" }],
      });
      await completion;

      const terminalStatus = extractText(handleCycleStatus(stateManager, evidenceManager));
      const terminalDiagnose = extractText(await handleCycleDiagnose(stateManager, evidenceManager, tempDir));
      expect(terminalStatus).not.toContain("Gate 0: executing");
      expect(terminalDiagnose).not.toContain("Executing Gate 0 attempts:");
    });

    it("rejects cycle reset while a Gate 0 attempt is executing", async () => {
      let resolveGate!: (value: { passed: boolean; checks: Array<{ name: string; passed: boolean; detail: string }> }) => void;
      checkGate0Exit.mockImplementationOnce((_taskId, _config, _projectRoot, options) => {
        options.onCheckStart({ check_name: "tests", command: "npm test" });
        return new Promise((resolve) => {
          resolveGate = resolve;
        });
      });

      const completion = handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);
      const evidenceManager = new EvidenceManager(tempDir);
      const preview = await handleCycleReset({ confirm: false }, stateManager, evidenceManager, tempDir);
      const reset = await handleCycleReset({ confirm: true }, stateManager, evidenceManager, tempDir);

      expect(preview.isError).toBe(true);
      expect(reset.isError).toBe(true);
      expect(extractText(reset)).toContain("Cannot reset cycle while Gate 0 attempt");
      expect(stateManager.load()).not.toBeNull();
      expect(evidenceManager.load("gate_0", "1.1.2")).not.toBeNull();

      resolveGate({
        passed: true,
        checks: [{ name: "tests", passed: true, detail: "All tests passed" }],
      });
      await completion;
    });

    it("returns the active attempt identity without rerunning concurrent completion", async () => {
      let resolveGate!: (value: { passed: boolean; checks: Array<{ name: string; passed: boolean; detail: string }> }) => void;
      checkGate0Exit.mockImplementationOnce(() => new Promise((resolve) => {
        resolveGate = resolve;
      }));

      const first = handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);
      const duplicate = await handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);
      const evidence = JSON.parse(readFileSync(join(tempDir, ".rigor", "evidence", "gate_0-task-1.1.2.json"), "utf-8"));

      expect(checkGate0Exit).toHaveBeenCalledTimes(1);
      expect(extractText(duplicate)).toContain(evidence.gate_0_attempt.id);
      expect(extractText(duplicate)).toContain("already executing");
      expect(extractText(duplicate)).toContain("cycle_status");

      resolveGate({
        passed: true,
        checks: [{ name: "tests", passed: true, detail: "All tests passed" }],
      });
      await first;
    });

    it("keeps terminal attempt history when a retried completion replaces canonical evidence", async () => {
      checkGate0Exit.mockResolvedValueOnce({
        passed: false,
        checks: [{ name: "tests", passed: false, detail: "Tests failed" }],
      });
      await handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);
      const evidenceManager = new EvidenceManager(tempDir);
      const firstAttempt = evidenceManager.load("gate_0", "1.1.2")!.gate_0_attempt!.id;

      handleTaskRetry({ task_id: "1.1.2" }, stateManager, evidenceManager, tempDir);
      stateManager.transition("1.1.2", "doing");
      checkGate0Exit.mockResolvedValueOnce({
        passed: true,
        checks: [{ name: "tests", passed: true, detail: "All tests passed" }],
      });
      await handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);

      const canonical = evidenceManager.load("gate_0", "1.1.2");
      expect(canonical?.passed).toBe(true);
      expect(canonical?.gate_0_attempt?.id).not.toBe(firstAttempt);
      expect(evidenceManager.load("gate_0", "1.1.2")).not.toBeNull();
      expect(existsSync(evidenceManager.attemptPathFor("1.1.2", firstAttempt))).toBe(true);
      expect(existsSync(evidenceManager.attemptPathFor("1.1.2", canonical!.gate_0_attempt!.id))).toBe(true);
    });

    it("rejects legacy completion for leased tasks and enforces matching unexpired credentials", async () => {
      const state = stateManager.load()!;
      const task = state.phases[0].epics[0].tasks.find((candidate) => candidate.id === "1.1.2")!;
      const lease = {
        owner_id: "owner-a",
        attempt_id: "attempt-a",
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
      task.lease = lease;
      stateManager.save(state);

      const legacy = await handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);
      const mismatched = await handleTaskComplete(
        { task_id: "1.1.2", owner_id: "owner-a", attempt_id: "wrong-attempt" },
        stateManager,
        config,
        tempDir,
      );

      expect(legacy.isError).toBe(true);
      expect(mismatched.isError).toBe(true);
      expect(checkGate0Exit).not.toHaveBeenCalled();

      const expiredState = stateManager.load()!;
      expiredState.phases[0].epics[0].tasks.find((task) => task.id === "1.1.2")!.lease!.lease_expires_at = new Date(Date.now() - 1_000).toISOString();
      stateManager.save(expiredState);

      const expired = await handleTaskComplete(
        { task_id: "1.1.2", owner_id: lease.owner_id, attempt_id: lease.attempt_id },
        stateManager,
        config,
        tempDir,
      );

      expect(expired.isError).toBe(true);
      expect(extractText(expired)).toContain("lease expired");
      expect(checkGate0Exit).not.toHaveBeenCalled();
    });

    it("returns matching terminal evidence without rerunning Gate 0", async () => {
      checkGate0Exit.mockResolvedValue({
        passed: true,
        checks: [{ name: "tests", passed: true, detail: "All tests passed" }],
      });

      await handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);
      const duplicate = await handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);

      expect(checkGate0Exit).toHaveBeenCalledTimes(1);
      expect(duplicate.isError).toBeUndefined();
      expect(extractText(duplicate)).toContain("returning persisted evidence");
      expect(extractText(duplicate)).toContain("[PASS] tests");
    });

    it("returns matching failed terminal evidence without rerunning Gate 0", async () => {
      checkGate0Exit.mockResolvedValue({
        passed: false,
        checks: [{ name: "tests", passed: false, detail: "Tests failed" }],
      });

      await handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);
      const duplicate = await handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);

      expect(checkGate0Exit).toHaveBeenCalledTimes(1);
      expect(duplicate.isError).toBe(true);
      expect(extractText(duplicate)).toContain("returning persisted evidence");
      expect(extractText(duplicate)).toContain("[FAIL] tests");
    });

    it("does not accept mismatched terminal task state and Gate 0 evidence", async () => {
      const evidenceManager = new EvidenceManager(tempDir);
      evidenceManager.save({
        gate: "gate_0",
        entity_id: "1.1.2",
        passed: true,
        timestamp: new Date().toISOString(),
        checks: [{ name: "tests", passed: true, detail: "All tests passed" }],
        gate_0_attempt: { version: 1, id: "attempt", started_at: new Date().toISOString(), finished_at: new Date().toISOString(), outcome: "passed" },
      });
      stateManager.transition("1.1.2", "failed");

      const duplicate = await handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);

      expect(duplicate.isError).toBe(true);
      expect(extractText(duplicate)).toContain('is in "failed" status');
      expect(checkGate0Exit).not.toHaveBeenCalled();
    });

    it("does not accept done state with failed Gate 0 evidence", async () => {
      const evidenceManager = new EvidenceManager(tempDir);
      evidenceManager.save({
        gate: "gate_0",
        entity_id: "1.1.2",
        passed: false,
        timestamp: new Date().toISOString(),
        checks: [{ name: "tests", passed: false, detail: "Tests failed" }],
        gate_0_attempt: { version: 1, id: "attempt", started_at: new Date().toISOString(), finished_at: new Date().toISOString(), outcome: "failed" },
      });
      stateManager.transition("1.1.2", "done");

      const duplicate = await handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);

      expect(duplicate.isError).toBe(true);
      expect(extractText(duplicate)).toContain('is in "done" status');
      expect(checkGate0Exit).not.toHaveBeenCalled();
    });

    it("records timeout evidence and reports timeout without an exit code", async () => {
      checkGate0Exit.mockResolvedValue({
        passed: false,
        checks: [{
          name: "tests",
          passed: false,
          detail: "Tests timed out after 5000ms",
          command: "npm test",
          duration_ms: 5_000,
          configured_timeout_ms: 5_000,
          timed_out: true,
          cancelled: false,
        }],
      });
      const originalTransition = stateManager.transition.bind(stateManager);
      const transition = vi.spyOn(stateManager, "transition");
      transition.mockImplementation((taskId, status) => {
        if (taskId === "1.1.2" && status === "failed") {
          const terminalEvidence = JSON.parse(readFileSync(join(tempDir, ".rigor", "evidence", "gate_0-task-1.1.2.json"), "utf-8"));
          expect(terminalEvidence.gate_0_attempt).toMatchObject({
            version: 1,
            outcome: "timed_out",
          });
        }
        return originalTransition(taskId, status);
      });

      const result = await handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);
      const evidence = JSON.parse(readFileSync(join(tempDir, ".rigor", "evidence", "gate_0-task-1.1.2.json"), "utf-8"));

      expect(extractText(result)).toContain("Tests timed out");
      expect(extractText(result)).not.toContain("exit code -1");
      expect(evidence.gate_0_attempt).toMatchObject({
        version: 1,
        outcome: "timed_out",
      });
      expect(evidence.gate_0_attempt.finished_at).toBeDefined();
      expect(evidence.checks[0]).toMatchObject({
        command: "npm test",
        duration_ms: 5_000,
        configured_timeout_ms: 5_000,
        timed_out: true,
        cancelled: false,
      });
    });

    it("records cancellation distinctly from timeout", async () => {
      checkGate0Exit.mockResolvedValue({
        passed: false,
        checks: [{
          name: "tests",
          passed: false,
          detail: "Tests were cancelled",
          timed_out: false,
          cancelled: true,
        }],
      });

      const result = await handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);
      const evidence = JSON.parse(readFileSync(join(tempDir, ".rigor", "evidence", "gate_0-task-1.1.2.json"), "utf-8"));

      expect(extractText(result)).toContain("Tests were cancelled");
      expect(evidence.gate_0_attempt.outcome).toBe("cancelled");
      expect(evidence.checks[0]).toMatchObject({ timed_out: false, cancelled: true });
    });

    it("records an execution error and fails the task when the gate runner throws", async () => {
      checkGate0Exit.mockRejectedValue(new Error("runner unavailable"));

      const result = await handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);
      const evidence = JSON.parse(readFileSync(join(tempDir, ".rigor", "evidence", "gate_0-task-1.1.2.json"), "utf-8"));

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("runner unavailable");
      expect(evidence.gate_0_attempt.outcome).toBe("execution_error");
      expect(evidence.checks[0].detail).toContain("runner unavailable");
      const task = stateManager.getTask("1.1.2");
      expect(task.status).toBe("failed");
      expect(task.gate_0.passed).toBe(false);
      expect(task.gate_0.evidence_path).toContain("gate_0-task-1.1.2.json");
    });

    it("rejects a taken-over attempt at the progress boundary without canonical mutation", async () => {
      const initialState = stateManager.load()!;
      initialState.phases[0].epics[0].tasks.find((candidate) => candidate.id === "1.1.2")!.lease = { owner_id: "owner-a", attempt_id: "attempt-a", lease_expires_at: new Date(Date.now() + 60_000).toISOString() };
      stateManager.save(initialState);
      const attemptId = "attempt-a";
      checkGate0Exit.mockImplementationOnce(async (_taskId, _config, _projectRoot, options) => {
        const state = stateManager.load()!;
        const task = state.phases[0].epics[0].tasks.find((candidate) => candidate.id === "1.1.2")!;
        task.lease!.lease_expires_at = new Date(Date.now() - 1).toISOString();
        stateManager.save(state);
        await handleTaskStart({ task_id: "1.1.2", owner_id: "owner-b", takeover: true }, stateManager, config, tempDir);
        await options.onCheckStart({ check_name: "tests", command: "npm test" });
        return { passed: true, checks: [{ name: "tests", passed: true, detail: "All tests passed" }] };
      });

      const result = await handleTaskComplete({ task_id: "1.1.2", owner_id: "owner-a", attempt_id: attemptId }, stateManager, config, tempDir);
      const evidence = new EvidenceManager(tempDir);

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("stale");
      expect(stateManager.getTask("1.1.2")).toMatchObject({ status: "doing", lease: { owner_id: "owner-b" } });
      expect(evidence.load("gate_0", "1.1.2")?.gate_0_attempt?.finished_at).toBeUndefined();
      expect(existsSync(evidence.attemptPathFor("1.1.2", attemptId))).toBe(true);
    });

    it("retains thrown stale attempt history without transitioning the takeover", async () => {
      const initialState = stateManager.load()!;
      initialState.phases[0].epics[0].tasks.find((candidate) => candidate.id === "1.1.2")!.lease = { owner_id: "owner-a", attempt_id: "attempt-a", lease_expires_at: new Date(Date.now() + 60_000).toISOString() };
      stateManager.save(initialState);
      const attemptId = "attempt-a";
      checkGate0Exit.mockImplementationOnce(async () => {
        const state = stateManager.load()!;
        const task = state.phases[0].epics[0].tasks.find((candidate) => candidate.id === "1.1.2")!;
        task.lease!.lease_expires_at = new Date(Date.now() - 1).toISOString();
        stateManager.save(state);
        await handleTaskStart({ task_id: "1.1.2", owner_id: "owner-b", takeover: true }, stateManager, config, tempDir);
        throw new Error("runner unavailable");
      });

      const result = await handleTaskComplete({ task_id: "1.1.2", owner_id: "owner-a", attempt_id: attemptId }, stateManager, config, tempDir);
      const evidence = new EvidenceManager(tempDir);

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("stale");
      expect(stateManager.getTask("1.1.2")).toMatchObject({ status: "doing", lease: { owner_id: "owner-b" } });
      expect(evidence.load("gate_0", "1.1.2")?.gate_0_attempt?.finished_at).toBeUndefined();
      expect(evidence.latestTerminalGate0Attempt("1.1.2")?.gate_0_attempt).toMatchObject({ id: attemptId, outcome: "execution_error" });
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

      runCustomGates.mockResolvedValueOnce({
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

       const task = stateManager.getTask("1.1.2");
       const gate0Evidence = new EvidenceManager(tempDir).load("gate_0", "1.1.2");
       expect(task.status).toBe("failed");
       expect(task.gate_0).toMatchObject({ passed: false, evidence_path: expect.any(String) });
       expect(gate0Evidence).toMatchObject({
         passed: true,
         gate_0_attempt: { outcome: "passed", finished_at: expect.any(String) },
       });
     });

      it("returns persisted terminal results after post_task custom gate failure", async () => {
        checkGate0Exit.mockResolvedValue({
          passed: true,
          checks: [{ name: "tests", passed: true, detail: "All tests passed" }],
        });
        runCustomGates.mockResolvedValueOnce({
          passed: false,
          checks: [{ name: "custom:security-scan", passed: false, detail: "Rejected" }],
        });
 
        await handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);
        const duplicate = await handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);
 
        expect(duplicate.isError).toBe(true);
        expect(extractText(duplicate)).toContain("returning persisted evidence");
        expect(extractText(duplicate)).toContain("[PASS] tests");
        expect(extractText(duplicate)).toContain("[FAIL] custom:security-scan");
        expect(checkGate0Exit).toHaveBeenCalledTimes(1);
        expect(runCustomGates).toHaveBeenCalledTimes(1);
      });

      it("reports pending post_task custom gates as active without rerunning", async () => {
        checkGate0Exit.mockResolvedValue({
          passed: true,
          checks: [{ name: "tests", passed: true, detail: "All tests passed" }],
        });
        let resolveCustom!: (value: { passed: boolean; checks: Array<{ name: string; passed: boolean; detail: string }> }) => void;
        runCustomGates.mockImplementationOnce(() => new Promise((resolve) => {
          resolveCustom = resolve;
        }));

        const first = handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);
        await vi.waitFor(() => expect(runCustomGates).toHaveBeenCalledTimes(1));
        const duplicate = await handleTaskComplete({ task_id: "1.1.2" }, stateManager, config, tempDir);
        const status = extractText(handleCycleStatus(stateManager, new EvidenceManager(tempDir), tempDir));

        expect(extractText(duplicate)).toContain("already executing");
        expect(checkGate0Exit).toHaveBeenCalledTimes(1);
        expect(runCustomGates).toHaveBeenCalledTimes(1);
        expect(status).toContain("Gate 0: post_task custom gates executing.");

        resolveCustom({ passed: true, checks: [] });
        await first;
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

      runCustomGates.mockResolvedValueOnce({
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
