/**
 * Tests for EvidenceManager — save and load gate evidence.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceManager, classifyGate0Attempt } from "../manager.js";
import type { GateEvidence } from "../manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sampleEvidence(overrides?: Partial<GateEvidence>): GateEvidence {
  return {
    gate: "gate_0",
    entity_id: "1.1.1",
    passed: true,
    timestamp: "2026-07-16T00:00:00.000Z",
    checks: [
      {
        name: "tests",
        passed: true,
        detail: "All tests passed",
        command: "npm test",
        exit_code: 0,
        duration_ms: 1234,
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("EvidenceManager", () => {
  let tempDir: string;
  let manager: EvidenceManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rigor-evidence-test-"));
    manager = new EvidenceManager(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 1. save creates evidence JSON file at correct path
  // -----------------------------------------------------------------------
  it("saves evidence as JSON at the expected path", () => {
    const evidence = sampleEvidence();
    const path = manager.save(evidence);

    expect(path).toContain("gate_0-task-1.1.1.json");
    expect(existsSync(path)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 2. load returns saved evidence
  // -----------------------------------------------------------------------
  it("loads previously saved evidence", () => {
    const evidence = sampleEvidence();
    manager.save(evidence);

    const loaded = manager.load("gate_0", "1.1.1");

    expect(loaded).not.toBeNull();
    expect(loaded?.gate).toBe("gate_0");
    expect(loaded?.entity_id).toBe("1.1.1");
    expect(loaded?.passed).toBe(true);
    expect(loaded?.checks).toHaveLength(1);
    expect(loaded?.checks[0].name).toBe("tests");
  });

  it("preserves versioned Gate 0 attempt and command interruption fields", () => {
    manager.save(sampleEvidence({
      passed: false,
      checks: [{
        name: "tests",
        passed: false,
        detail: "Tests timed out after 60000ms",
        command: "npm test",
        duration_ms: 60_100,
        configured_timeout_ms: 60_000,
        timed_out: true,
        cancelled: false,
      }],
      gate_0_attempt: {
        version: 1,
        id: "attempt-123",
        started_at: "2026-07-16T00:00:00.000Z",
        finished_at: "2026-07-16T00:01:00.000Z",
        outcome: "timed_out",
      },
    }));

    const loaded = manager.load("gate_0", "1.1.1");
    expect(loaded?.gate_0_attempt?.outcome).toBe("timed_out");
    expect(loaded?.checks[0]).toMatchObject({
      command: "npm test",
      duration_ms: 60_100,
      configured_timeout_ms: 60_000,
      timed_out: true,
      cancelled: false,
    });
  });

  it("retains immutable terminal attempts while updating canonical evidence", () => {
    const first = sampleEvidence({
      passed: false,
      gate_0_attempt: {
        version: 1,
        id: "attempt-1",
        started_at: "2026-07-16T00:00:00.000Z",
        finished_at: "2026-07-16T00:01:00.000Z",
        outcome: "failed",
      },
    });
    const second = sampleEvidence({
      gate_0_attempt: {
        version: 1,
        id: "attempt-2",
        started_at: "2026-07-16T00:02:00.000Z",
        finished_at: "2026-07-16T00:03:00.000Z",
        outcome: "passed",
      },
    });

    manager.saveTerminalGate0Attempt(first);
    manager.saveTerminalGate0Attempt(second);

    expect(manager.load("gate_0", "1.1.1")?.gate_0_attempt?.id).toBe("attempt-2");
    expect(existsSync(manager.attemptPathFor("1.1.1", "attempt-1"))).toBe(true);
    expect(manager.load("gate_0", "1.1.1")?.passed).toBe(true);
    expect(() => manager.saveTerminalGate0Attempt(first)).toThrow("attempt-1");
  });

  it("classifies live, interrupted, terminal, and inconsistent attempts", () => {
    const inProgress = sampleEvidence({
      passed: false,
      gate_0_attempt: { version: 1, id: "attempt", started_at: "2026-07-16T00:00:00.000Z" },
    });
    expect(classifyGate0Attempt(inProgress, "doing", true)).toBe("live");
    expect(classifyGate0Attempt(inProgress, "doing", false)).toBe("interrupted");
    expect(classifyGate0Attempt(sampleEvidence({
      gate_0_attempt: { version: 1, id: "attempt", started_at: "2026-07-16T00:00:00.000Z", finished_at: "2026-07-16T00:01:00.000Z", outcome: "passed" },
    }), "doing", false)).toBe("terminal_passed");
    expect(classifyGate0Attempt(sampleEvidence({
      passed: false,
      gate_0_attempt: { version: 1, id: "attempt", started_at: "2026-07-16T00:00:00.000Z", finished_at: "2026-07-16T00:01:00.000Z", outcome: "passed" },
    }), "doing", false)).toBe("inconsistent");
  });

  // -----------------------------------------------------------------------
  // 3. load returns null for missing evidence
  // -----------------------------------------------------------------------
  it("returns null when evidence file does not exist", () => {
    const result = manager.load("gate_0", "9.9.9");

    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 4. creates .rigor/evidence/ directory on construction
  // -----------------------------------------------------------------------
  it("creates the evidence directory if it does not exist", () => {
    const evidenceDir = join(tempDir, ".rigor", "evidence");
    expect(existsSync(evidenceDir)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 5. preserves dots in entity_id in filename
  // -----------------------------------------------------------------------
  it("preserves dots in entity_id in the filename", () => {
    const evidence = sampleEvidence({ entity_id: "2.3.4" });
    const path = manager.save(evidence);

    expect(path).toContain("gate_0-task-2.3.4.json");
  });

  // -----------------------------------------------------------------------
  // 6. delete removes a specific evidence file
  // -----------------------------------------------------------------------
  it("delete returns true and removes the file when it exists", () => {
    const evidence = sampleEvidence();
    const path = manager.save(evidence);

    expect(existsSync(path)).toBe(true);
    const result = manager.delete("gate_0", "1.1.1");
    expect(result).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("delete returns false when the file does not exist", () => {
    const result = manager.delete("gate_0", "9.9.9");
    expect(result).toBe(false);
  });

  it("delete does not affect other evidence files", () => {
    manager.save(sampleEvidence({ entity_id: "1.1.1" }));
    const otherPath = manager.save(sampleEvidence({ entity_id: "1.1.2" }));

    manager.delete("gate_0", "1.1.1");
    expect(existsSync(otherPath)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 7. deleteAll removes evidence for all gates of an entity
  // -----------------------------------------------------------------------
  it("deleteAll removes gate_0, gate_8, and gate_9 evidence", () => {
    manager.save(sampleEvidence({ gate: "gate_0", entity_id: "1.1" }));
    manager.save(sampleEvidence({ gate: "gate_8", entity_id: "1.1" }));
    manager.save(sampleEvidence({ gate: "gate_9", entity_id: "1.1" }));

    const count = manager.deleteAll("1.1");
    expect(count).toBe(3);

    expect(manager.load("gate_0", "1.1")).toBeNull();
    expect(manager.load("gate_8", "1.1")).toBeNull();
    expect(manager.load("gate_9", "1.1")).toBeNull();
  });

  it("deletes all task-scoped evidence and preserves epic-owned evidence", () => {
    manager.save(sampleEvidence({ entity_id: "1.1.1" }));
    manager.save(sampleEvidence({ gate: "gate_1", entity_id: "1.1.1" }));
    manager.save(sampleEvidence({ gate: "custom_post_task", entity_id: "1.1.1" }));
    manager.saveTerminalGate0Attempt(sampleEvidence({
      passed: false,
      gate_0_attempt: { version: 1, id: "attempt-1", started_at: "2026-07-16T00:00:00.000Z", finished_at: "2026-07-16T00:01:00.000Z", outcome: "failed" },
    }));
    manager.save(sampleEvidence({ gate: "gate_8", entity_id: "1.1" }));
    manager.save(sampleEvidence({ gate: "gate_9", entity_id: "1.1" }));

    expect(manager.deleteTaskEvidence("1.1.1")).toBe(4);
    expect(manager.load("gate_0", "1.1.1")).toBeNull();
    expect(existsSync(manager.attemptPathFor("1.1.1", "attempt-1"))).toBe(false);
    expect(manager.load("gate_8", "1.1")).not.toBeNull();
    expect(manager.load("gate_9", "1.1")).not.toBeNull();
  });

  it("summarizes the latest and prior terminal attempt outcomes", () => {
    manager.saveTerminalGate0Attempt(sampleEvidence({
      passed: false,
      gate_0_attempt: { version: 1, id: "attempt-1", started_at: "2026-07-16T00:00:00.000Z", finished_at: "2026-07-16T00:01:00.000Z", outcome: "failed" },
    }));
    manager.saveTerminalGate0Attempt(sampleEvidence({
      gate_0_attempt: { version: 1, id: "attempt-2", started_at: "2026-07-16T00:02:00.000Z", finished_at: "2026-07-16T00:03:00.000Z", outcome: "passed" },
    }));

    expect(manager.taskEvidenceSummary("1.1.1")).toEqual({ latest: "passed", prior: ["failed"] });
  });

  it("deleteAll returns 0 when no evidence exists for the entity", () => {
    const count = manager.deleteAll("9.9.9");
    expect(count).toBe(0);
  });

  it("deleteAll counts only existing files", () => {
    manager.save(sampleEvidence({ gate: "gate_0", entity_id: "1.1" }));
    // gate_8 and gate_9 not saved
    const count = manager.deleteAll("1.1");
    expect(count).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 8. clearAll removes all files in the evidence directory
  // -----------------------------------------------------------------------
  it("clearAll removes all evidence files and returns count", () => {
    manager.save(sampleEvidence({ entity_id: "1.1.1" }));
    manager.save(sampleEvidence({ entity_id: "1.1.2" }));
    manager.save(sampleEvidence({ gate: "gate_8", entity_id: "1.1" }));

    const count = manager.clearAll();
    expect(count).toBe(3);

    expect(manager.load("gate_0", "1.1.1")).toBeNull();
    expect(manager.load("gate_0", "1.1.2")).toBeNull();
    expect(manager.load("gate_8", "1.1")).toBeNull();
  });

  it("clearAll returns 0 when evidence directory is empty", () => {
    const count = manager.clearAll();
    expect(count).toBe(0);
  });
});
