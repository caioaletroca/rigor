/**
 * Tests for cycle_init and cycle_status tool handlers.
 *
 * These test the extracted handler functions directly -- no MCP transport
 * needed. Each test gets a fresh temp directory so state files don't collide.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "../../state/index.js";
import { EvidenceManager } from "../../evidence/index.js";
import { handleCycleInit, handleCycleStatus, handleCycleReload } from "../cycle.js";
import type { CycleInitParams } from "../cycle.js";
import { DEFAULTS } from "../../config/index.js";

// ---------------------------------------------------------------------------
// Fixture path
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "plan",
  "__tests__",
  "fixtures",
);
const SAMPLE_PLAN = join(FIXTURE_DIR, "sample-plan.md");
const TEST_CONFIG = {
  ...DEFAULTS,
  workspace: {
    ...DEFAULTS.workspace,
    require_worktree: false,
    require_feature_branch: false,
    allow_override: true,
  },
};

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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("cycle tools", () => {
  let tempDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rigor-cycle-test-"));
    stateManager = new StateManager(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // cycle_init
  // -----------------------------------------------------------------------

  describe("cycle_init", () => {
    it("creates state from plan and returns success with counts", () => {
      const planPath = join(tempDir, "plan.md");
      cpSync(SAMPLE_PLAN, planPath);
      const params: CycleInitParams = { plan_path: planPath };
      const result = handleCycleInit(params, stateManager, tempDir, TEST_CONFIG);

      expect(result.isError).toBeUndefined();

      const text = extractText(result);
      const parsed = JSON.parse(text) as Record<string, unknown>;

      expect(parsed.phases).toBe(2);
      expect(parsed.epics).toBe(3);
      expect(parsed.tasks).toBe(3);
      expect(parsed.cycle_id).toBeDefined();
      expect(parsed.plan_path).toBeDefined();

      // Verify state was persisted
      const loaded = stateManager.load();
      expect(loaded).not.toBeNull();
      expect(loaded?.phases).toHaveLength(2);
    });

    it("resolves relative plan_path against projectRoot", () => {
      // Copy the fixture into the temp dir
      const planName = "my-plan.md";
      cpSync(SAMPLE_PLAN, join(tempDir, planName));

      const params: CycleInitParams = { plan_path: planName };
      const result = handleCycleInit(params, stateManager, tempDir, TEST_CONFIG);

      expect(result.isError).toBeUndefined();

      const text = extractText(result);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      expect(parsed.phases).toBe(2);
    });

    it("rejects when a cycle already exists", () => {
      // Init first cycle
      const planPath = join(tempDir, "plan.md");
      cpSync(SAMPLE_PLAN, planPath);
      const params: CycleInitParams = { plan_path: planPath };
      handleCycleInit(params, stateManager, tempDir, TEST_CONFIG);

      // Try to init again
      const result = handleCycleInit(params, stateManager, tempDir, TEST_CONFIG);

      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text).toContain("cycle already exists");
    });

    it("treats re-init with a relative path to the same plan as same-plan", () => {
      const planName = "my-plan.md";
      cpSync(SAMPLE_PLAN, join(tempDir, planName));

      handleCycleInit({ plan_path: planName }, stateManager, tempDir, TEST_CONFIG);

      const result = handleCycleInit(
        { plan_path: join(tempDir, planName) },
        stateManager,
        tempDir,
        TEST_CONFIG,
      );

      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text).toContain("cycle already exists");
      expect(text).toContain("cycle_reset");
    });

    it("rejects a foreign plan without recommending cycle_reset", () => {
      const planPath = join(tempDir, "plan.md");
      cpSync(SAMPLE_PLAN, planPath);
      handleCycleInit({ plan_path: planPath }, stateManager, tempDir, TEST_CONFIG);
      const existing = stateManager.load();

      const otherPlanName = "other-plan.md";
      cpSync(SAMPLE_PLAN, join(tempDir, otherPlanName));

      const result = handleCycleInit(
        { plan_path: otherPlanName },
        stateManager,
        tempDir,
        TEST_CONFIG,
      );

      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text).toContain(existing!.cycle_id);
      expect(text).toContain(existing!.plan_path);
      expect(text).not.toContain("cycle_reset");
      expect(text).toContain("rigor:worktree");
    });

    it("rejects a shared workspace override when project config disables it", () => {
      const result = handleCycleInit(
        { plan_path: "plan.md", allow_shared_workspace: true },
        stateManager,
        tempDir,
        {
          ...TEST_CONFIG,
          workspace: { ...TEST_CONFIG.workspace, allow_override: false },
        },
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("allow_shared_workspace is disabled");
    });

    it("allows an explicit shared workspace override when project config permits it", () => {
      const planPath = join(tempDir, "plan.md");
      cpSync(SAMPLE_PLAN, planPath);
      const result = handleCycleInit(
        { plan_path: planPath, allow_shared_workspace: true },
        stateManager,
        tempDir,
        {
          ...TEST_CONFIG,
          workspace: {
            ...TEST_CONFIG.workspace,
            require_worktree: true,
            require_feature_branch: true,
          },
        },
      );

      expect(result.isError).toBeUndefined();
    });

    it("throws on invalid plan path", () => {
      const params: CycleInitParams = { plan_path: "/nonexistent/plan.md" };

      expect(() =>
        handleCycleInit(params, stateManager, tempDir, TEST_CONFIG),
      ).toThrow();
    });

    it("maps task done checkbox to done status", () => {
      const planPath = join(tempDir, "plan.md");
      cpSync(SAMPLE_PLAN, planPath);
      const params: CycleInitParams = { plan_path: planPath };
      handleCycleInit(params, stateManager, tempDir, TEST_CONFIG);

      const state = stateManager.load();
      // Task 1.1.1 has [x] Done in sample-plan.md
      const task111 = state?.phases[0]?.epics[0]?.tasks[0];
      expect(task111?.id).toBe("1.1.1");
      expect(task111?.status).toBe("done");

      // Task 1.1.2 has [ ] Done
      const task112 = state?.phases[0]?.epics[0]?.tasks[1];
      expect(task112?.id).toBe("1.1.2");
      expect(task112?.status).toBe("pending");
    });
  });

  // -----------------------------------------------------------------------
  // cycle_status
  // -----------------------------------------------------------------------

  describe("cycle_status", () => {
    it("returns 'no active cycle' when no state exists", () => {
      const result = handleCycleStatus(stateManager);

      const text = extractText(result);
      expect(text).toContain("No active cycle");
    });

    it("returns correct summary for a fresh cycle", () => {
      const planPath = join(tempDir, "plan.md");
      cpSync(SAMPLE_PLAN, planPath);
      handleCycleInit({ plan_path: planPath }, stateManager, tempDir, TEST_CONFIG);

      const result = handleCycleStatus(stateManager);
      const text = extractText(result);

      expect(text).toContain("Cycle:");
      expect(text).toContain("Current Phase: 1");
      expect(text).toContain("Epics:");
      expect(text).toContain("1.1 User service");
      expect(text).toContain("1.2 Config loader");
      expect(text).toContain("2.1 Observability and monitoring");
      expect(text).toContain("gate_8:fail");
      expect(text).toContain("gate_9:fail");
      expect(text).toContain("Active Task: none");
      // 1 done (1.1.1 [x]) out of 3 total in phase 1
      expect(text).toContain("1/3 tasks completed");
    });

    it("labels an unfinished persisted Gate 0 attempt as stale", () => {
      const planPath = join(tempDir, "plan.md");
      cpSync(SAMPLE_PLAN, planPath);
      handleCycleInit({ plan_path: planPath }, stateManager, tempDir);
      stateManager.transition("1.1.2", "doing");
      const evidenceManager = new EvidenceManager(tempDir);
      evidenceManager.save({
        gate: "gate_0",
        entity_id: "1.1.2",
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

      const text = extractText(handleCycleStatus(stateManager, evidenceManager));
      expect(text).toContain("Gate 0: stale unfinished attempt; task remains stuck.");
      expect(text).not.toContain("Gate 0: executing");
    });

    it("does not report a stale attempt as executing when its timeout is unconfigured", () => {
      const planPath = join(tempDir, "plan.md");
      cpSync(SAMPLE_PLAN, planPath);
      handleCycleInit({ plan_path: planPath }, stateManager, tempDir);
      stateManager.transition("1.1.2", "doing");
      const evidenceManager = new EvidenceManager(tempDir);
      evidenceManager.save({
        gate: "gate_0",
        entity_id: "1.1.2",
        passed: false,
        timestamp: new Date().toISOString(),
        checks: [],
        gate_0_attempt: {
          version: 1,
          id: "attempt-123",
          started_at: new Date().toISOString(),
          current_check: {
            check_name: "test_files",
            command: "git status --porcelain",
            started_at: new Date().toISOString(),
          },
        },
      });

      const text = extractText(handleCycleStatus(stateManager, evidenceManager));
      expect(text).toContain("Gate 0: stale unfinished attempt; task remains stuck.");
      expect(text).not.toContain("Gate 0: executing");
    });

    it("shows progress and active task for mid-progress cycle", () => {
      const planPath = join(tempDir, "plan.md");
      cpSync(SAMPLE_PLAN, planPath);
      handleCycleInit({ plan_path: planPath }, stateManager, tempDir, TEST_CONFIG);

      // Transition task 1.1.2 to "doing"
      stateManager.transition("1.1.2", "doing");

      const result = handleCycleStatus(stateManager);
      const text = extractText(result);

      expect(text).toContain("Active Task: 1.1.2");
      expect(text).toContain("Add GET /users/:id handler");
      // Still 1/3 done (1.1.1 is done, 1.1.2 is doing, 1.2.1 is pending)
      expect(text).toContain("1/3 tasks completed");
    });
  });

  // -----------------------------------------------------------------------
  // cycle_reload (rolling-wave elaboration)
  // -----------------------------------------------------------------------

  describe("cycle_reload", () => {
    it("errors when no cycle exists", () => {
      const result = handleCycleReload({}, stateManager, tempDir);
      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("No active cycle");
    });

    it("adds newly-elaborated tasks to an epic and preserves existing progress", () => {
      const planPath = join(tempDir, "plan.md");
      cpSync(SAMPLE_PLAN, planPath);
      handleCycleInit({ plan_path: planPath }, stateManager, tempDir);

      // Epic 2.1 starts with zero tasks (epic-level in the fixture).
      const epic21Before = stateManager.load()!.phases[1].epics[0];
      expect(epic21Before.id).toBe("2.1");
      expect(epic21Before.tasks).toHaveLength(0);

      // Advance Phase 1 progress that must be preserved across reload.
      stateManager.transition("1.1.2", "doing");

      // Elaborate Epic 2.1 with a task, then reload.
      const expanded =
        readFileSync(SAMPLE_PLAN, "utf-8") +
        [
          "",
          "#### Task 2.1.1: Add healthz endpoint",
          "",
          "- [ ] Done",
          "",
          "**Context:** none.",
          "",
          "**Files:**",
          "- Create: `src/health/healthz.ts`",
          "",
          "**Verification:** `npm test`",
          "",
          "**Done when:** `/healthz` returns 200",
          "",
        ].join("\n");
      writeFileSync(planPath, expanded, "utf-8");

      const result = handleCycleReload({}, stateManager, tempDir);
      expect(result.isError).toBeUndefined();
      const summary = JSON.parse(extractText(result)) as {
        added: { phases: number; epics: number; tasks: number };
      };
      expect(summary.added.tasks).toBe(1);

      const state = stateManager.load()!;
      const epic21 = state.phases[1].epics[0];
      expect(epic21.tasks.map((t) => t.id)).toContain("2.1.1");
      expect(epic21.tasks.find((t) => t.id === "2.1.1")?.status).toBe("pending");

      // Existing progress preserved (not reset).
      const e11 = state.phases[0].epics[0];
      expect(e11.tasks.find((t) => t.id === "1.1.1")?.status).toBe("done");
      expect(e11.tasks.find((t) => t.id === "1.1.2")?.status).toBe("doing");
    });

    it("is a no-op (adds nothing) when the plan is unchanged", () => {
      const planPath = join(tempDir, "plan.md");
      cpSync(SAMPLE_PLAN, planPath);
      handleCycleInit({ plan_path: planPath }, stateManager, tempDir);

      const result = handleCycleReload({}, stateManager, tempDir);
      const summary = JSON.parse(extractText(result)) as {
        added: { phases: number; epics: number; tasks: number };
      };
      expect(summary.added).toEqual({ phases: 0, epics: 0, tasks: 0 });
      expect(stateManager.load()!.phases[0].epics[0].tasks).toHaveLength(2);
    });
  });
});
