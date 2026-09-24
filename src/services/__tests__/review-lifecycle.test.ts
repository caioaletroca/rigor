import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DEFAULTS } from "../../config/index.js";
import { EvidenceManager } from "../../evidence/index.js";
import type { ReviewFindings } from "../../gates/index.js";
import { StateManager } from "../../state/index.js";
import type { PhaseState } from "../../state/index.js";

vi.mock("../../gates/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gates/index.js")>();
  return { ...actual, runCustomGates: vi.fn().mockResolvedValue({ passed: true, checks: [] }) };
});

const { runCustomGates } = await import("../../gates/index.js") as {
  runCustomGates: ReturnType<typeof vi.fn>;
} & typeof import("../../gates/index.js");
const { handleAcceptSubmit, handleReviewStart, handleReviewSubmit } = await import("../review-lifecycle.js");

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0].text ?? "";
}

function makePhases(): PhaseState[] {
  return [{
    id: 1,
    status: "pending",
    epics: [{
      id: "1.1",
      name: "User service",
      status: "pending",
      tasks: [{ id: "1.1.1", name: "Create user handler", status: "done", gate_0: { passed: true } }],
      gate_8: { passed: false },
      gate_9: { passed: false },
    }],
  }];
}

function passingSubmissions(): ReviewFindings[] {
  return [
    { reviewer: "security", verdict: "PASS", findings: [] },
    { reviewer: "logic", verdict: "PASS", findings: [] },
  ];
}

describe("review lifecycle service", () => {
  let tempDir: string;
  let stateManager: StateManager;
  let evidenceManager: EvidenceManager;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), "rigor-review-lifecycle-test-"));
    stateManager = new StateManager(tempDir);
    evidenceManager = new EvidenceManager(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("starts and submits review when an intentionally skipped task follows completed tasks", async () => {
    const phases = makePhases();
    phases[0].epics[0].tasks.push({
      id: "1.1.2",
      name: "Deferred browser coverage",
      status: "skipped",
      gate_0: { passed: false },
    });
    stateManager.init("test-plan.md", phases);

    const started = await handleReviewStart({ epic_id: "1.1" }, stateManager, DEFAULTS, tempDir);
    const submitted = await handleReviewSubmit(
      { epic_id: "1.1", submissions: JSON.stringify(passingSubmissions()) },
      stateManager,
      evidenceManager,
      DEFAULTS,
      tempDir,
    );

    expect(started.isError).toBeUndefined();
    expect(extractText(started)).toContain("1 skipped");
    expect(submitted.isError).toBeUndefined();
    expect(stateManager.getEpic("1.1").gate_8.passed).toBe(true);
  });

  it.each(["pending", "doing", "failed"] as const)("rejects review when a task is %s", async (status) => {
    const phases = makePhases();
    phases[0].epics[0].tasks.push({
      id: "1.1.2",
      name: "Incomplete task",
      status,
      gate_0: { passed: false },
    });
    stateManager.init("test-plan.md", phases);

    const result = await handleReviewStart({ epic_id: "1.1" }, stateManager, DEFAULTS, tempDir);

    expect(result.isError).toBe(true);
    expect(extractText(result)).toContain("incomplete tasks");
  });

  it("starts review after completed Gate 0 tasks and records Gate 8 evidence", async () => {
    stateManager.init("test-plan.md", makePhases());

    const started = await handleReviewStart({ epic_id: "1.1" }, stateManager, DEFAULTS, tempDir);
    const submitted = await handleReviewSubmit(
      { epic_id: "1.1", submissions: JSON.stringify(passingSubmissions()) },
      stateManager,
      evidenceManager,
      DEFAULTS,
      tempDir,
    );

    expect(started.isError).toBeUndefined();
    expect(extractText(started)).toContain("Review started for epic 1.1");
    expect(submitted.isError).toBeUndefined();
    expect(stateManager.getEpic("1.1").gate_8.passed).toBe(true);
    expect(evidenceManager.load("gate_8", "1.1")?.review_submissions).toEqual(passingSubmissions());
  });

  it("keeps an epic open when the post-accept custom gate fails", async () => {
    stateManager.init("test-plan.md", makePhases());
    await handleReviewStart({ epic_id: "1.1" }, stateManager, DEFAULTS, tempDir);
    await handleReviewSubmit(
      { epic_id: "1.1", submissions: JSON.stringify(passingSubmissions()) },
      stateManager,
      evidenceManager,
      DEFAULTS,
      tempDir,
    );
    runCustomGates.mockResolvedValueOnce({
      passed: false,
      checks: [{ name: "custom:deploy", passed: false, detail: "failed" }],
    });

    const result = await handleAcceptSubmit(
      { epic_id: "1.1", criteria: JSON.stringify([{ criterion: "Works", evidence: "Tested", met: true }]), user_approved: true },
      stateManager,
      evidenceManager,
      DEFAULTS,
      tempDir,
    );

    expect(result.isError).toBe(true);
    expect(extractText(result)).toContain("failed post_accept custom gate");
    expect(stateManager.getEpic("1.1").status).toBe("doing");
    expect(stateManager.getEpic("1.1").gate_9.passed).toBe(false);
    expect(evidenceManager.load("gate_9", "1.1")?.passed).toBe(false);
  });

  it("revalidates review eligibility after the pre-review custom gate", async () => {
    stateManager.init("test-plan.md", makePhases());
    let resolveGate: (result: { passed: boolean; checks: never[] }) => void;
    const gate = new Promise<{ passed: boolean; checks: never[] }>((resolve) => { resolveGate = resolve; });
    runCustomGates.mockReturnValueOnce(gate);

    const started = handleReviewStart({ epic_id: "1.1" }, stateManager, DEFAULTS, tempDir);
    const state = stateManager.load()!;
    state.phases[0].epics[0].tasks[0].status = "doing";
    stateManager.save(state);
    resolveGate!({ passed: true, checks: [] });

    const result = await started;
    expect(result.isError).toBe(true);
    expect(extractText(result)).toContain("incomplete tasks");
    expect(stateManager.getEpic("1.1").status).toBe("pending");
  });

  it("does not save acceptance evidence or transition after Gate 8 changes during post-accept", async () => {
    stateManager.init("test-plan.md", makePhases());
    await handleReviewStart({ epic_id: "1.1" }, stateManager, DEFAULTS, tempDir);
    await handleReviewSubmit(
      { epic_id: "1.1", submissions: JSON.stringify(passingSubmissions()) },
      stateManager,
      evidenceManager,
      DEFAULTS,
      tempDir,
    );
    let resolveGate: (result: { passed: boolean; checks: never[] }) => void;
    const gate = new Promise<{ passed: boolean; checks: never[] }>((resolve) => { resolveGate = resolve; });
    runCustomGates.mockReturnValueOnce(gate);

    const submitted = handleAcceptSubmit(
      { epic_id: "1.1", criteria: JSON.stringify([{ criterion: "Works", evidence: "Tested", met: true }]), user_approved: true },
      stateManager,
      evidenceManager,
      DEFAULTS,
      tempDir,
    );
    const state = stateManager.load()!;
    state.phases[0].epics[0].gate_8.passed = false;
    stateManager.save(state);
    resolveGate!({ passed: true, checks: [] });

    const result = await submitted;
    expect(result.isError).toBe(true);
    expect(extractText(result)).toContain("has not passed Gate 8");
    expect(stateManager.getEpic("1.1").gate_9.passed).toBe(false);
    expect(evidenceManager.load("gate_9", "1.1")).toBeNull();
    expect(stateManager.getEpic("1.1").status).toBe("doing");
  });

  it("serializes concurrent same-root review submissions and persists their ordered result", async () => {
    stateManager.init("test-plan.md", makePhases());
    await handleReviewStart({ epic_id: "1.1" }, stateManager, DEFAULTS, tempDir);
    const failed = [{
      reviewer: "security",
      verdict: "ISSUES_FOUND" as const,
      findings: [{ severity: "high" as const, file: "src/auth.ts:1", title: "Missing authorization", description: "Mutation is unprotected.", suggestion: "Require authorization.", source: "ai" }],
    }, { reviewer: "logic", verdict: "PASS" as const, findings: [] }];
    const first = handleReviewSubmit(
      { epic_id: "1.1", submissions: JSON.stringify(failed) },
      stateManager,
      evidenceManager,
      DEFAULTS,
      tempDir,
    );
    const second = handleReviewSubmit(
      { epic_id: "1.1", submissions: JSON.stringify(passingSubmissions()) },
      stateManager,
      evidenceManager,
      DEFAULTS,
      tempDir,
    );

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.isError).toBe(true);
    expect(secondResult.isError).toBeUndefined();
    expect(stateManager.getEpic("1.1").gate_8.passed).toBe(true);
    expect(evidenceManager.load("gate_8", "1.1")?.review_submissions).toEqual(passingSubmissions());
  });

  it("revalidates task completion before saving Gate 8 evidence", async () => {
    stateManager.init("test-plan.md", makePhases());
    await handleReviewStart({ epic_id: "1.1" }, stateManager, DEFAULTS, tempDir);
    const state = stateManager.load()!;
    state.phases[0].epics[0].tasks[0].gate_0.passed = false;
    stateManager.save(state);

    const result = await handleReviewSubmit(
      { epic_id: "1.1", submissions: JSON.stringify(passingSubmissions()) },
      stateManager,
      evidenceManager,
      DEFAULTS,
      tempDir,
    );

    expect(result.isError).toBe(true);
    expect(extractText(result)).toContain("incomplete tasks");
    expect(stateManager.getEpic("1.1").gate_8.passed).toBe(false);
    expect(evidenceManager.load("gate_8", "1.1")).toBeNull();
  });

  it("rejects malformed review submissions without mutating Gate 8 state or evidence", async () => {
    stateManager.init("test-plan.md", makePhases());
    await handleReviewStart({ epic_id: "1.1" }, stateManager, DEFAULTS, tempDir);

    for (const submissions of ["{}", JSON.stringify([{ reviewer: "security", verdict: "PASS" }])]) {
      const result = await handleReviewSubmit(
        { epic_id: "1.1", submissions },
        stateManager,
        evidenceManager,
        DEFAULTS,
        tempDir,
      );
      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("Invalid submissions JSON");
      expect(stateManager.getEpic("1.1").gate_8).toEqual({ passed: false });
      expect(evidenceManager.load("gate_8", "1.1")).toBeNull();
    }
  });

  it("persists failed Gate 8 evidence and permits a direct replacement submission", async () => {
    stateManager.init("test-plan.md", makePhases());
    await handleReviewStart({ epic_id: "1.1" }, stateManager, DEFAULTS, tempDir);
    const failed = await handleReviewSubmit(
      { epic_id: "1.1", submissions: JSON.stringify([{ reviewer: "security", verdict: "PASS", findings: [] }]) },
      stateManager,
      evidenceManager,
      DEFAULTS,
      tempDir,
    );
    expect(failed.isError).toBe(true);
    expect(stateManager.getEpic("1.1").gate_8.passed).toBe(false);
    expect(evidenceManager.load("gate_8", "1.1")?.passed).toBe(false);

    const replaced = await handleReviewSubmit(
      { epic_id: "1.1", submissions: JSON.stringify(passingSubmissions()) },
      stateManager,
      evidenceManager,
      DEFAULTS,
      tempDir,
    );
    expect(replaced.isError).toBeUndefined();
    expect(stateManager.getEpic("1.1").gate_8.passed).toBe(true);
    expect(evidenceManager.load("gate_8", "1.1")?.review_submissions).toEqual(passingSubmissions());
  });

  it("rejects malformed acceptance criteria without mutating Gate 9 state or evidence", async () => {
    stateManager.init("test-plan.md", makePhases());
    await handleReviewStart({ epic_id: "1.1" }, stateManager, DEFAULTS, tempDir);
    await handleReviewSubmit(
      { epic_id: "1.1", submissions: JSON.stringify(passingSubmissions()) },
      stateManager,
      evidenceManager,
      DEFAULTS,
      tempDir,
    );

    for (const criteria of ["{", JSON.stringify([{ criterion: "Works", evidence: "Tested" }]), "[]"]) {
      const result = await handleAcceptSubmit(
        { epic_id: "1.1", criteria, user_approved: true },
        stateManager,
        evidenceManager,
        DEFAULTS,
        tempDir,
      );
      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("Invalid criteria JSON");
      expect(stateManager.getEpic("1.1").gate_9).toEqual({ passed: false });
      expect(evidenceManager.load("gate_9", "1.1")).toBeNull();
    }
  });
});
