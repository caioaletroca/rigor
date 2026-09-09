import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArchiveManager } from "../manager.js";
import type { CycleState } from "../../state/schema.js";

function sampleState(): CycleState {
  return {
    cycle_id: "completed-cycle",
    plan_path: "docs/plans/completed-cycle.md",
    current_phase: 1,
    created_at: "2026-09-08T00:00:00.000Z",
    updated_at: "2026-09-08T00:00:00.000Z",
    phases: [],
  };
}

describe("ArchiveManager", () => {
  let projectRoot: string;
  let state: CycleState;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "rigor-archive-test-"));
    state = sampleState();
    mkdirSync(join(projectRoot, ".rigor", "evidence"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".rigor", "state.json"),
      JSON.stringify(state),
    );
    writeFileSync(
      join(projectRoot, ".rigor", "evidence", "gate_0-task-1.1.1.json"),
      '{"passed":true}',
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("copies state and evidence into a validated archive", () => {
    const result = new ArchiveManager(projectRoot).archive(
      state,
      new Date("2026-09-08T12:34:56.789Z"),
    );

    expect(result.evidenceCount).toBe(1);
    expect(JSON.parse(readFileSync(join(result.path, "state.json"), "utf-8"))).toEqual(state);
    expect(
      existsSync(join(result.path, "evidence", "gate_0-task-1.1.1.json")),
    ).toBe(true);
    expect(existsSync(join(projectRoot, ".rigor", "state.json"))).toBe(true);
    expect(
      existsSync(join(projectRoot, ".rigor", "evidence", "gate_0-task-1.1.1.json")),
    ).toBe(true);
  });

  it("archives and restores nested Gate 0 attempt history", () => {
    const historyDir = join(projectRoot, ".rigor", "evidence", "gate_0-task-1.1.1");
    mkdirSync(historyDir);
    writeFileSync(join(historyDir, "attempt-1.json"), '{"passed":false}');

    const manager = new ArchiveManager(projectRoot);
    const result = manager.archive(state);
    expect(result.evidenceCount).toBe(2);
    expect(existsSync(join(result.path, "evidence", "gate_0-task-1.1.1", "attempt-1.json"))).toBe(true);

    rmSync(join(projectRoot, ".rigor", "evidence"), { recursive: true });
    manager.restoreEvidence(result.path);
    expect(existsSync(join(projectRoot, ".rigor", "evidence", "gate_0-task-1.1.1", "attempt-1.json"))).toBe(true);
  });

  it("rejects an unsafe cycle ID without creating an archive", () => {
    state.cycle_id = "../../outside-history";

    expect(() => new ArchiveManager(projectRoot).archive(state)).toThrow(
      "cycle ID is not a safe directory name",
    );
    expect(existsSync(join(projectRoot, ".rigor", "history"))).toBe(false);
  });

  it("uses a distinct archive path when the timestamp collides", () => {
    const manager = new ArchiveManager(projectRoot);
    const completedAt = new Date("2026-09-08T12:34:56.789Z");

    const first = manager.archive(state, completedAt);
    const second = manager.archive(state, completedAt);

    expect(second.path).not.toBe(first.path);
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);
  });

  it("does not copy temporary evidence files", () => {
    writeFileSync(
      join(projectRoot, ".rigor", "evidence", "gate_0-task-1.1.2.json.tmp"),
      "partial",
    );

    const result = new ArchiveManager(projectRoot).archive(state);

    expect(
      existsSync(join(result.path, "evidence", "gate_0-task-1.1.2.json.tmp")),
    ).toBe(false);
  });

  it("keeps active artifacts when the active state is missing", () => {
    rmSync(join(projectRoot, ".rigor", "state.json"));
    const evidencePath = join(
      projectRoot,
      ".rigor",
      "evidence",
      "gate_0-task-1.1.1.json",
    );

    expect(() => new ArchiveManager(projectRoot).archive(state)).toThrow(
      "active state.json does not exist",
    );
    expect(existsSync(evidencePath)).toBe(true);
    expect(existsSync(join(projectRoot, ".rigor", "history"))).toBe(false);
  });
});
