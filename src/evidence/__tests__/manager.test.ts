/**
 * Tests for EvidenceManager — save and load gate evidence.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceManager } from "../manager.js";
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
});
