/**
 * Tests for review, acceptance, and phase advance tool handlers.
 *
 * Uses real temp directories with StateManager and EvidenceManager.
 * Gate 8/9 logic is pure functions (no mocking needed).
 * runCustomGates is mocked since it calls shell commands.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "../../state/index.js";
import { EvidenceManager } from "../../evidence/index.js";
import { DEFAULTS } from "../../config/index.js";
import type { RigorConfig } from "../../config/index.js";
import type { PhaseState } from "../../state/index.js";
import type { ReviewFindings } from "../../gates/index.js";
import type { AcceptanceCriterion } from "../../gates/index.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../gates/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gates/index.js")>();
  return {
    ...actual,
    runCustomGates: vi.fn().mockReturnValue({ passed: true, checks: [] }),
  };
});

const { runCustomGates } = await import("../../gates/index.js") as {
  runCustomGates: ReturnType<typeof vi.fn>;
} & typeof import("../../gates/index.js");

const {
  handleReviewStart,
  handleReviewSubmit,
  handleAcceptStart,
  handleAcceptSubmit,
  handlePhaseAdvance,
} = await import("../review.js");

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
 * Build phases where all tasks in epic 1.1 are done with gate_0 passed.
 */
function makePhases(): PhaseState[] {
  return [
    {
      id: 1,
      status: "pending",
      epics: [
        {
          id: "1.1",
          name: "User service",
          status: "pending",
          tasks: [
            {
              id: "1.1.1",
              name: "Create user handler",
              status: "done",
              gate_0: { passed: true },
            },
            {
              id: "1.1.2",
              name: "Add GET endpoint",
              status: "done",
              gate_0: { passed: true },
            },
          ],
          gate_8: { passed: false },
          gate_9: { passed: false },
        },
      ],
    },
    {
      id: 2,
      status: "pending",
      epics: [
        {
          id: "2.1",
          name: "Monitoring",
          status: "pending",
          tasks: [
            {
              id: "2.1.1",
              name: "Add health check",
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

/**
 * Build phases where one task in the epic is still pending.
 */
function makePhasesWithIncompleteTask(): PhaseState[] {
  return [
    {
      id: 1,
      status: "pending",
      epics: [
        {
          id: "1.1",
          name: "User service",
          status: "pending",
          tasks: [
            {
              id: "1.1.1",
              name: "Create user handler",
              status: "done",
              gate_0: { passed: true },
            },
            {
              id: "1.1.2",
              name: "Add GET endpoint",
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

function passingSubmissions(): ReviewFindings[] {
  return [
    { reviewer: "security", verdict: "PASS", findings: [] },
    { reviewer: "logic", verdict: "PASS", findings: [] },
  ];
}

function passingCriteria(): AcceptanceCriterion[] {
  return [
    { criterion: "API works", evidence: "Tested", met: true },
    { criterion: "Errors handled", evidence: "Tested", met: true },
  ];
}

const config: RigorConfig = DEFAULTS;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("review tools", () => {
  let tempDir: string;
  let stateManager: StateManager;
  let evidenceManager: EvidenceManager;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), "rigor-review-test-"));
    stateManager = new StateManager(tempDir);
    evidenceManager = new EvidenceManager(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // review_start
  // -----------------------------------------------------------------------

  describe("review_start", () => {
    // 1. Succeeds when all tasks done
    it("succeeds when all tasks are done and passed Gate 0", () => {
      stateManager.init("test-plan.md", makePhases());

      const result = handleReviewStart(
        { epic_id: "1.1" },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBeUndefined();
      const text = extractText(result);
      expect(text).toContain("Review started for epic 1.1");
      expect(text).toContain("User service");
      expect(text).toContain("Tasks: 2");
      expect(text).toContain("Expected reviewers:");

      // Epic should now be "doing"
      const epic = stateManager.getEpic("1.1");
      expect(epic.status).toBe("doing");
    });

    // 2. Rejects when tasks incomplete
    it("rejects when tasks are incomplete", () => {
      stateManager.init("test-plan.md", makePhasesWithIncompleteTask());

      const result = handleReviewStart(
        { epic_id: "1.1" },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text).toContain("Cannot start review");
      expect(text).toContain("1.1.2");
    });

    // 3. Blocks when pre_review custom gate fails
    it("blocks when pre_review custom gate fails", () => {
      stateManager.init("test-plan.md", makePhases());

      runCustomGates.mockReturnValueOnce({
        passed: false,
        checks: [
          {
            name: "custom:changelog",
            passed: false,
            detail: 'Custom gate "changelog" failed (exit code 1)',
          },
        ],
      });

      const result = handleReviewStart(
        { epic_id: "1.1" },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text).toContain("blocked by custom pre_review gate");
      expect(text).toContain("[FAIL] custom:changelog");
    });
  });

  // -----------------------------------------------------------------------
  // review_submit
  // -----------------------------------------------------------------------

  describe("review_submit", () => {
    // 3. Saves evidence and updates state
    it("saves evidence and updates state on pass", () => {
      stateManager.init("test-plan.md", makePhases());
      // Start review first (transitions epic to "doing")
      handleReviewStart({ epic_id: "1.1" }, stateManager, config, tempDir);

      const submissions = passingSubmissions();
      const result = handleReviewSubmit(
        { epic_id: "1.1", submissions: JSON.stringify(submissions) },
        stateManager,
        evidenceManager,
        config,
      );

      expect(result.isError).toBeUndefined();
      const text = extractText(result);
      expect(text).toContain("Gate 8 PASSED");
      expect(text).toContain("[PASS] required_reviewers_complete");
      expect(text).toContain("[PASS] critical_threshold");
      expect(text).toContain("[PASS] high_threshold");
      expect(text).toContain("Evidence:");

      // Check state was updated
      const epic = stateManager.getEpic("1.1");
      expect(epic.gate_8.passed).toBe(true);
      expect(epic.gate_8.evidence_path).toBeDefined();

      // Check evidence was saved
      const evidence = evidenceManager.load("gate_8", "1.1");
      expect(evidence).not.toBeNull();
      expect(evidence?.passed).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // accept_start
  // -----------------------------------------------------------------------

  describe("accept_start", () => {
    // 4. Succeeds when gate_8 passed
    it("succeeds when gate_8 passed", () => {
      stateManager.init("test-plan.md", makePhases());
      handleReviewStart({ epic_id: "1.1" }, stateManager, config, tempDir);
      handleReviewSubmit(
        { epic_id: "1.1", submissions: JSON.stringify(passingSubmissions()) },
        stateManager,
        evidenceManager,
        config,
      );

      const result = handleAcceptStart(
        { epic_id: "1.1" },
        stateManager,
      );

      expect(result.isError).toBeUndefined();
      const text = extractText(result);
      expect(text).toContain("Acceptance started for epic 1.1");
      expect(text).toContain("Gate 8: passed");
    });

    // 5. Rejects when gate_8 not passed
    it("rejects when gate_8 not passed", () => {
      stateManager.init("test-plan.md", makePhases());

      const result = handleAcceptStart(
        { epic_id: "1.1" },
        stateManager,
      );

      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text).toContain("not passed Gate 8");
    });
  });

  // -----------------------------------------------------------------------
  // accept_submit
  // -----------------------------------------------------------------------

  describe("accept_submit", () => {
    // 6. Transitions epic to done on pass
    it("transitions epic to done on pass", () => {
      stateManager.init("test-plan.md", makePhases());
      handleReviewStart({ epic_id: "1.1" }, stateManager, config, tempDir);
      handleReviewSubmit(
        { epic_id: "1.1", submissions: JSON.stringify(passingSubmissions()) },
        stateManager,
        evidenceManager,
        config,
      );

      const criteria = passingCriteria();
      const result = handleAcceptSubmit(
        {
          epic_id: "1.1",
          criteria: JSON.stringify(criteria),
          user_approved: true,
        },
        stateManager,
        evidenceManager,
        config,
        tempDir,
      );

      expect(result.isError).toBeUndefined();
      const text = extractText(result);
      expect(text).toContain("Gate 9 PASSED");
      expect(text).toContain("Epic is now done");

      // Check epic is done
      const epic = stateManager.getEpic("1.1");
      expect(epic.status).toBe("done");
      expect(epic.gate_9.passed).toBe(true);

      // Check evidence was saved
      const evidence = evidenceManager.load("gate_9", "1.1");
      expect(evidence).not.toBeNull();
      expect(evidence?.passed).toBe(true);
    });

    // 7. Blocks when post_accept custom gate fails
    it("returns error when post_accept custom gate fails", () => {
      stateManager.init("test-plan.md", makePhases());
      handleReviewStart({ epic_id: "1.1" }, stateManager, config, tempDir);
      handleReviewSubmit(
        { epic_id: "1.1", submissions: JSON.stringify(passingSubmissions()) },
        stateManager,
        evidenceManager,
        config,
      );

      runCustomGates.mockReturnValueOnce({
        passed: false,
        checks: [
          {
            name: "custom:deploy-check",
            passed: false,
            detail: 'Custom gate "deploy-check" failed (exit code 1)',
          },
        ],
      });

      const criteria = passingCriteria();
      const result = handleAcceptSubmit(
        {
          epic_id: "1.1",
          criteria: JSON.stringify(criteria),
          user_approved: true,
        },
        stateManager,
        evidenceManager,
        config,
        tempDir,
      );

      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text).toContain("passed Gate 9 but failed post_accept custom gate");
      expect(text).toContain("[FAIL] custom:deploy-check");

      // Epic should NOT be transitioned to "done"
      const epic = stateManager.getEpic("1.1");
      expect(epic.status).not.toBe("done");
    });
  });

  // -----------------------------------------------------------------------
  // phase_advance
  // -----------------------------------------------------------------------

  describe("phase_advance", () => {
    /**
     * Helper: drive an epic through the full review+accept pipeline.
     */
    function completeEpic(epicId: string): void {
      handleReviewStart({ epic_id: epicId }, stateManager, config, tempDir);
      handleReviewSubmit(
        { epic_id: epicId, submissions: JSON.stringify(passingSubmissions()) },
        stateManager,
        evidenceManager,
        config,
      );
      handleAcceptSubmit(
        {
          epic_id: epicId,
          criteria: JSON.stringify(passingCriteria()),
          user_approved: true,
        },
        stateManager,
        evidenceManager,
        config,
        tempDir,
      );
    }

    // 7. Transitions to next phase when all epics done
    it("transitions to next phase when all epics in current phase are done", () => {
      stateManager.init("test-plan.md", makePhases());

      // Complete the single epic in phase 1
      completeEpic("1.1");

      const result = handlePhaseAdvance(stateManager);

      expect(result.isError).toBeUndefined();
      const text = extractText(result);
      expect(text).toContain("Phase 1 completed");
      expect(text).toContain("Advanced to phase 2");
      expect(text).toContain("now doing");

      // Check state
      const state = stateManager.load();
      expect(state?.current_phase).toBe(2);

      const phase1 = state?.phases.find((p) => p.id === 1);
      expect(phase1?.status).toBe("done");

      const phase2 = state?.phases.find((p) => p.id === 2);
      expect(phase2?.status).toBe("doing");
    });

    // 8. Rejects when epics incomplete
    it("rejects when epics are incomplete", () => {
      stateManager.init("test-plan.md", makePhases());

      const result = handlePhaseAdvance(stateManager);

      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text).toContain("Cannot advance phase 1");
      expect(text).toContain("1.1");
    });

    // 9. Reports cycle complete when no more phases
    it("reports cycle complete when no more phases", () => {
      // Single-phase plan
      const singlePhase: PhaseState[] = [
        {
          id: 1,
          status: "pending",
          epics: [
            {
              id: "1.1",
              name: "Only epic",
              status: "pending",
              tasks: [
                {
                  id: "1.1.1",
                  name: "Only task",
                  status: "done",
                  gate_0: { passed: true },
                },
              ],
              gate_8: { passed: false },
              gate_9: { passed: false },
            },
          ],
        },
      ];

      stateManager.init("test-plan.md", singlePhase);

      // Complete the epic
      completeEpic("1.1");

      const result = handlePhaseAdvance(stateManager);

      expect(result.isError).toBeUndefined();
      const text = extractText(result);
      expect(text).toContain("Phase 1 completed");
      expect(text).toContain("All phases complete");
      expect(text).toContain("cycle finished");
    });
  });
});
