/**
 * Tests for review, acceptance, and phase advance tool handlers.
 *
 * Uses real temp directories with StateManager and EvidenceManager.
 * Gate 8/9 logic is pure functions (no mocking needed).
 * runCustomGates is mocked since it calls shell commands.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "../../state/index.js";
import { EvidenceManager } from "../../evidence/index.js";
import { ArchiveManager } from "../../archive/manager.js";
import { DEFAULTS } from "../../config/index.js";
import type { RigorConfig } from "../../config/index.js";
import type { PhaseState } from "../../state/index.js";
import type { ReviewFindings } from "../../gates/index.js";
import type { AcceptanceCriterion } from "../../gates/index.js";
import { handleCycleInit } from "../cycle.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../gates/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gates/index.js")>();
  return {
    ...actual,
    runCustomGates: vi.fn().mockResolvedValue({ passed: true, checks: [] }),
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
} = await import("../../services/review-lifecycle.js");
const { registerReviewTools } = await import("../review.js");

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

describe("review tools", async () => {
  it("registers review lifecycle MCP schemas", () => {
    const tool = vi.fn();
    const registerTool = vi.fn();

    registerReviewTools({ tool, registerTool } as never, {} as StateManager, {} as EvidenceManager, "C:/project");

    expect(tool.mock.calls.map(([name]) => name)).toEqual(["review_start", "review_submit", "accept_start", "accept_submit"]);
    expect(registerTool.mock.calls.map(([name]) => name)).toEqual(["phase_advance"]);
    expect(tool.mock.calls[0][2].epic_id.safeParse("").success).toBe(true);
    expect(tool.mock.calls[3][2].user_approved.safeParse(undefined).success).toBe(true);
  });

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

  describe("review_start", async () => {
    // 1. Succeeds when all tasks done
    it("succeeds when all tasks are done and passed Gate 0", async () => {
      stateManager.init("test-plan.md", makePhases());

      const result = await handleReviewStart(
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

    // 1b. Rejects an epic with no tasks (rolling-wave / unelaborated epic)
    it("rejects an epic that has no tasks", async () => {
      const phases = makePhases();
      phases[0].epics[0].tasks = [];
      stateManager.init("test-plan.md", phases);

      const result = await handleReviewStart(
        { epic_id: "1.1" },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("no tasks");
    });

    // 1c. Reloads config from disk when config is null (no stale boot config)
    it("reloads gate config from disk when config is null", async () => {
      stateManager.init("test-plan.md", makePhases());
      mkdirSync(join(tempDir, ".rigor"), { recursive: true });
      writeFileSync(
        join(tempDir, ".rigor", "config.yaml"),
        "gates:\n  gate_8:\n    reviewers:\n      - security\n      - logic\n",
        "utf-8",
      );

      const result = await handleReviewStart(
        { epic_id: "1.1" },
        stateManager,
        null,
        tempDir,
      );

      expect(result.isError).toBeUndefined();
      // Reviewers reflect the on-disk file, not the default 10-reviewer list.
      expect(extractText(result)).toContain("Expected reviewers: security, logic");
    });

    it("rejects restarting a review that already has evidence", async () => {
      stateManager.init("test-plan.md", makePhases());
      await handleReviewStart({ epic_id: "1.1" }, stateManager, config, tempDir);
      await handleReviewSubmit(
        { epic_id: "1.1", submissions: JSON.stringify(passingSubmissions()) },
        stateManager,
        evidenceManager,
        config,
        tempDir,
      );

      const result = await handleReviewStart(
        { epic_id: "1.1" },
        stateManager,
        config,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("Gate 8 already passed");
      expect(extractText(result)).toContain("accept_start");
    });

    // 2. Rejects when tasks incomplete
    it("rejects when tasks are incomplete", async () => {
      stateManager.init("test-plan.md", makePhasesWithIncompleteTask());

      const result = await handleReviewStart(
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
    it("blocks when pre_review custom gate fails", async () => {
      stateManager.init("test-plan.md", makePhases());

      runCustomGates.mockResolvedValueOnce({
        passed: false,
        checks: [
          {
            name: "custom:changelog",
            passed: false,
            detail: 'Custom gate "changelog" failed (exit code 1)',
          },
        ],
      });

      const result = await handleReviewStart(
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

  describe("review_submit", async () => {
    // 3. Saves evidence and updates state
    it("saves evidence and updates state on pass", async () => {
      stateManager.init("test-plan.md", makePhases());
      // Start review first (transitions epic to "doing")
      await handleReviewStart({ epic_id: "1.1" }, stateManager, config, tempDir);

      const submissions = passingSubmissions();
      const result = await handleReviewSubmit(
        { epic_id: "1.1", submissions: JSON.stringify(submissions) },
        stateManager,
        evidenceManager,
        config,
        tempDir,
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
      expect(evidence?.review_submissions).toEqual(submissions);
    });

    it("saves failed findings and allows direct resubmission", async () => {
      stateManager.init("test-plan.md", makePhases());
      await handleReviewStart({ epic_id: "1.1" }, stateManager, config, tempDir);
      const failedSubmissions: ReviewFindings[] = [
        {
          reviewer: "security",
          verdict: "ISSUES_FOUND",
          findings: [{
            severity: "high",
            file: "src/auth.ts:10",
            title: "Missing authorization",
            description: "Mutation is not protected.",
            suggestion: "Require authorization.",
            source: "ai",
          }],
        },
        { reviewer: "logic", verdict: "PASS", findings: [] },
      ];

      const failed = await handleReviewSubmit(
        { epic_id: "1.1", submissions: JSON.stringify(failedSubmissions) },
        stateManager,
        evidenceManager,
        config,
        tempDir,
      );
      const restart = await handleReviewStart(
        { epic_id: "1.1" }, stateManager, config, tempDir,
      );
      const passed = await handleReviewSubmit(
        { epic_id: "1.1", submissions: JSON.stringify(passingSubmissions()) },
        stateManager,
        evidenceManager,
        config,
        tempDir,
      );

      expect(failed.isError).toBe(true);
      expect(extractText(failed)).toContain("findings were saved");
       expect(restart.isError).toBe(true);
       expect(extractText(restart)).toContain("without another review_start");
       expect(stateManager.getEpic("1.1").status).toBe("doing");
       expect(passed.isError).toBeUndefined();
      expect(evidenceManager.load("gate_8", "1.1")?.review_submissions)
        .toEqual(passingSubmissions());
    });
  });

  // -----------------------------------------------------------------------
  // accept_start
  // -----------------------------------------------------------------------

  describe("accept_start", async () => {
    // 4. Succeeds when gate_8 passed
    it("succeeds when gate_8 passed", async () => {
      stateManager.init("test-plan.md", makePhases());
      await handleReviewStart({ epic_id: "1.1" }, stateManager, config, tempDir);
      await handleReviewSubmit(
        { epic_id: "1.1", submissions: JSON.stringify(passingSubmissions()) },
        stateManager,
        evidenceManager,
        config,
        tempDir,
      );

      const result = await handleAcceptStart(
        { epic_id: "1.1" },
        stateManager,
      );

      expect(result.isError).toBeUndefined();
      const text = extractText(result);
      expect(text).toContain("Acceptance started for epic 1.1");
      expect(text).toContain("Gate 8: passed");
    });

    // 5. Rejects when gate_8 not passed
    it("rejects when gate_8 not passed", async () => {
      stateManager.init("test-plan.md", makePhases());

      const result = await handleAcceptStart(
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

  describe("accept_submit", async () => {
    // 6. Transitions epic to done on pass
    it("transitions epic to done on pass", async () => {
      stateManager.init("test-plan.md", makePhases());
      await handleReviewStart({ epic_id: "1.1" }, stateManager, config, tempDir);
      await handleReviewSubmit(
        { epic_id: "1.1", submissions: JSON.stringify(passingSubmissions()) },
        stateManager,
        evidenceManager,
        config,
        tempDir,
      );

      const criteria = passingCriteria();
      const result = await handleAcceptSubmit(
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
    it("returns error when post_accept custom gate fails", async () => {
      stateManager.init("test-plan.md", makePhases());
      await handleReviewStart({ epic_id: "1.1" }, stateManager, config, tempDir);
      await handleReviewSubmit(
        { epic_id: "1.1", submissions: JSON.stringify(passingSubmissions()) },
        stateManager,
        evidenceManager,
        config,
        tempDir,
      );

      runCustomGates.mockResolvedValueOnce({
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
      const result = await handleAcceptSubmit(
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

    // 8. Rejects criteria with a missing `met` field as a schema error
    it("returns a schema error when a criterion is missing 'met' and writes no evidence", async () => {
      stateManager.init("test-plan.md", makePhases());
      await handleReviewStart({ epic_id: "1.1" }, stateManager, config, tempDir);
      await handleReviewSubmit(
        { epic_id: "1.1", submissions: JSON.stringify(passingSubmissions()) },
        stateManager,
        evidenceManager,
        config,
        tempDir,
      );

      const result = await handleAcceptSubmit(
        {
          epic_id: "1.1",
          // No `met` on the item — must be a schema error, not silent unmet.
          criteria: JSON.stringify([{ criterion: "x", evidence: "y" }]),
          user_approved: true,
        },
        stateManager,
        evidenceManager,
        config,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("Invalid criteria JSON");

      // No Gate 9 evidence written, epic not accepted.
      expect(evidenceManager.load("gate_9", "1.1")).toBeNull();
      expect(stateManager.getEpic("1.1").status).not.toBe("done");
    });

    // 9. Rejects an empty criteria array (min(1))
    it("returns a schema error for an empty criteria array", async () => {
      stateManager.init("test-plan.md", makePhases());
      await handleReviewStart({ epic_id: "1.1" }, stateManager, config, tempDir);
      await handleReviewSubmit(
        { epic_id: "1.1", submissions: JSON.stringify(passingSubmissions()) },
        stateManager,
        evidenceManager,
        config,
        tempDir,
      );

      const result = await handleAcceptSubmit(
        {
          epic_id: "1.1",
          criteria: "[]",
          user_approved: true,
        },
        stateManager,
        evidenceManager,
        config,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("Invalid criteria JSON");
      expect(evidenceManager.load("gate_9", "1.1")).toBeNull();
      expect(stateManager.getEpic("1.1").status).not.toBe("done");
    });
  });

  // -----------------------------------------------------------------------
  // phase_advance
  // -----------------------------------------------------------------------

  describe("phase_advance", async () => {
    /**
     * Helper: drive an epic through the full review+accept pipeline.
     */
    async function completeEpic(epicId: string): Promise<void> {
      await handleReviewStart({ epic_id: epicId }, stateManager, config, tempDir);
      await handleReviewSubmit(
        { epic_id: epicId, submissions: JSON.stringify(passingSubmissions()) },
        stateManager,
        evidenceManager,
        config,
        tempDir,
      );
      await handleAcceptSubmit(
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
    it("transitions to next phase when all epics in current phase are done", async () => {
      stateManager.init("test-plan.md", makePhases());

      // Complete the single epic in phase 1
      await completeEpic("1.1");

      const result = await handlePhaseAdvance(stateManager);

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
    it("rejects when epics are incomplete", async () => {
      stateManager.init("test-plan.md", makePhases());

      const result = await handlePhaseAdvance(stateManager);

      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text).toContain("Cannot advance phase 1");
      expect(text).toContain("1.1");
    });

    // 9. Reports cycle complete when no more phases
    it("reports cycle complete when no more phases", async () => {
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
      await completeEpic("1.1");

      const result = await handlePhaseAdvance(
        stateManager,
        evidenceManager,
        new ArchiveManager(tempDir),
      );

      expect(result.isError).toBeUndefined();
      const text = extractText(result);
      const archivePath = text.match(/^Archive: (.+)$/m)?.[1];
      expect(text).toContain("Phase 1 completed");
      expect(text).toContain("All phases complete");
      expect(text).toContain("cycle finished");
      expect(archivePath).toBeDefined();
      expect(stateManager.load()).toBeNull();
      expect(
        existsSync(join(tempDir, ".rigor", "evidence", "gate_9-task-1.1.json")),
      ).toBe(false);
      expect(
        existsSync(join(archivePath!, "evidence", "gate_9-task-1.1.json")),
      ).toBe(true);
      expect(
        JSON.parse(readFileSync(join(archivePath!, "state.json"), "utf-8")),
      ).toMatchObject({ cycle_id: "test-plan" });
      const planPath = join(tempDir, "next-plan.md");
      writeFileSync(
        planPath,
        "# Next Cycle\n\n## Phase Overview\n\n| Phase | Milestone | Epics | Status |\n|-------|-----------|-------|--------|\n| 1 | Next | 1.1 | Detailed |\n\n---\n\n## Phase 1: Next\n\n### Epic 1.1: Next work\n\n**Goal:** Start another cycle\n**Scope:** tests\n**Dependencies:** none\n**Done when:** cycle starts\n**Status:** Pending\n",
      );
      expect(
        handleCycleInit({ plan_path: planPath }, stateManager, tempDir).isError,
      ).toBeUndefined();
    });

    it("retains active artifacts when archival fails", async () => {
      const singlePhase = [makePhases()[0]];
      stateManager.init("test-plan.md", singlePhase);
      await completeEpic("1.1");
      vi.spyOn(ArchiveManager.prototype, "archive").mockImplementation(() => {
        throw new Error("archive storage unavailable");
      });

      const result = await handlePhaseAdvance(
        stateManager,
        evidenceManager,
        new ArchiveManager(tempDir),
      );

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("archive storage unavailable");
      expect(stateManager.load()).not.toBeNull();
      expect(evidenceManager.load("gate_9", "1.1")).not.toBeNull();
    });
  });
});
