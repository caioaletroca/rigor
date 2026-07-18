import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "../manager.js";
import { InvalidTransitionError, EntityNotFoundError } from "../errors.js";
import { isValidTransition } from "../schema.js";
import type { PhaseState, CycleState } from "../schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSamplePhases(): PhaseState[] {
  return [
    {
      id: 1,
      status: "pending",
      epics: [
        {
          id: "1.1",
          name: "Project setup",
          status: "pending",
          tasks: [
            {
              id: "1.1.1",
              name: "Init repo",
              status: "pending",
              gate_0: { passed: false },
            },
            {
              id: "1.1.2",
              name: "Config loader",
              status: "pending",
              gate_0: { passed: false },
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
          name: "Core features",
          status: "pending",
          tasks: [
            {
              id: "2.1.1",
              name: "Feature A",
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StateManager", () => {
  let tmpDir: string;
  let mgr: StateManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rigor-state-test-"));
    mgr = new StateManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 1. init creates state from phases with all statuses "pending"
  // -----------------------------------------------------------------------
  it("init creates state with all statuses pending", () => {
    const phases = makeSamplePhases();
    const state = mgr.init("docs/2026-07-16-mcp-server.md", phases);

    expect(state.cycle_id).toBe("2026-07-16-mcp-server");
    expect(state.plan_path).toBe("docs/2026-07-16-mcp-server.md");
    expect(state.current_phase).toBe(1);
    expect(state.phases).toHaveLength(2);

    // All entities start pending
    for (const phase of state.phases) {
      expect(phase.status).toBe("pending");
      for (const epic of phase.epics) {
        expect(epic.status).toBe("pending");
        for (const task of epic.tasks) {
          expect(task.status).toBe("pending");
        }
      }
    }
  });

  it("init derives cycle_id from plan filename without extension", () => {
    const state = mgr.init("plans/my-feature.yaml", makeSamplePhases());
    expect(state.cycle_id).toBe("my-feature");
  });

  it("init sets current_phase to first phase id", () => {
    const phases = makeSamplePhases();
    phases[0].id = 3;
    const state = mgr.init("plan.md", phases);
    expect(state.current_phase).toBe(3);
  });

  it("init handles empty phases array", () => {
    const state = mgr.init("plan.md", []);
    expect(state.current_phase).toBe(1);
    expect(state.phases).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 2. save + load round-trips correctly
  // -----------------------------------------------------------------------
  it("round-trips state through save and load", () => {
    const original = mgr.init("plan.md", makeSamplePhases());
    const loaded = mgr.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.cycle_id).toBe(original.cycle_id);
    expect(loaded!.plan_path).toBe(original.plan_path);
    expect(loaded!.phases).toHaveLength(original.phases.length);
    expect(loaded!.phases[0].epics[0].tasks[0].id).toBe("1.1.1");
  });

  it("persists valid JSON to disk", () => {
    mgr.init("plan.md", makeSamplePhases());
    const raw = readFileSync(
      join(tmpDir, ".rigor", "state.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as CycleState;
    expect(parsed.cycle_id).toBe("plan");
  });

  // -----------------------------------------------------------------------
  // 3. atomic write: .tmp file is created then renamed
  // -----------------------------------------------------------------------
  it("does not leave a .tmp file after save", () => {
    mgr.init("plan.md", makeSamplePhases());
    const tmpPath = join(tmpDir, ".rigor", "state.json.tmp");
    expect(existsSync(tmpPath)).toBe(false);
  });

  it("state.json exists after save", () => {
    mgr.init("plan.md", makeSamplePhases());
    const statePath = join(tmpDir, ".rigor", "state.json");
    expect(existsSync(statePath)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 4. invalid transition throws InvalidTransitionError
  // -----------------------------------------------------------------------
  it("throws InvalidTransitionError for pending -> done", () => {
    mgr.init("plan.md", makeSamplePhases());

    expect(() => mgr.transition("1.1.1", "done")).toThrow(
      InvalidTransitionError,
    );
  });

  it("throws InvalidTransitionError for pending -> failed", () => {
    mgr.init("plan.md", makeSamplePhases());

    expect(() => mgr.transition("1.1.1", "failed")).toThrow(
      InvalidTransitionError,
    );
  });

  it("throws InvalidTransitionError for done -> doing", () => {
    mgr.init("plan.md", makeSamplePhases());
    mgr.transition("1.1.1", "doing");
    mgr.transition("1.1.1", "done");

    expect(() => mgr.transition("1.1.1", "doing")).toThrow(
      InvalidTransitionError,
    );
  });

  it("InvalidTransitionError contains entity id and statuses", () => {
    mgr.init("plan.md", makeSamplePhases());

    try {
      mgr.transition("1.1.1", "done");
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      const ite = err as InvalidTransitionError;
      expect(ite.entityId).toBe("1.1.1");
      expect(ite.from).toBe("pending");
      expect(ite.to).toBe("done");
    }
  });

  // -----------------------------------------------------------------------
  // 5. valid transitions work
  // -----------------------------------------------------------------------
  it("transitions pending -> doing", () => {
    mgr.init("plan.md", makeSamplePhases());
    const state = mgr.transition("1.1.1", "doing");
    const task = state.phases[0].epics[0].tasks[0];
    expect(task.status).toBe("doing");
  });

  it("transitions doing -> done", () => {
    mgr.init("plan.md", makeSamplePhases());
    mgr.transition("1.1.1", "doing");
    const state = mgr.transition("1.1.1", "done");
    const task = state.phases[0].epics[0].tasks[0];
    expect(task.status).toBe("done");
  });

  it("transitions doing -> failed", () => {
    mgr.init("plan.md", makeSamplePhases());
    mgr.transition("1.1.1", "doing");
    const state = mgr.transition("1.1.1", "failed");
    const task = state.phases[0].epics[0].tasks[0];
    expect(task.status).toBe("failed");
  });

  it("transitions failed -> doing (retry)", () => {
    mgr.init("plan.md", makeSamplePhases());
    mgr.transition("1.1.1", "doing");
    mgr.transition("1.1.1", "failed");
    const state = mgr.transition("1.1.1", "doing");
    const task = state.phases[0].epics[0].tasks[0];
    expect(task.status).toBe("doing");
  });

  it("transitions work for epics", () => {
    mgr.init("plan.md", makeSamplePhases());
    const state = mgr.transition("1.1", "doing");
    const epic = state.phases[0].epics[0];
    expect(epic.status).toBe("doing");
  });

  it("transitions work for phases (numeric id)", () => {
    mgr.init("plan.md", makeSamplePhases());
    const state = mgr.transition("1", "doing");
    expect(state.phases[0].status).toBe("doing");
  });

  // -----------------------------------------------------------------------
  // 6. getTask / getEpic / getPhase find correct entities
  // -----------------------------------------------------------------------
  it("getTask returns the correct task", () => {
    mgr.init("plan.md", makeSamplePhases());
    const task = mgr.getTask("1.1.2");
    expect(task.id).toBe("1.1.2");
    expect(task.name).toBe("Config loader");
  });

  it("getTask finds tasks in later phases", () => {
    mgr.init("plan.md", makeSamplePhases());
    const task = mgr.getTask("2.1.1");
    expect(task.id).toBe("2.1.1");
    expect(task.name).toBe("Feature A");
  });

  it("getEpic returns the correct epic", () => {
    mgr.init("plan.md", makeSamplePhases());
    const epic = mgr.getEpic("2.1");
    expect(epic.id).toBe("2.1");
    expect(epic.name).toBe("Core features");
  });

  it("getPhase returns the correct phase", () => {
    mgr.init("plan.md", makeSamplePhases());
    const phase = mgr.getPhase(2);
    expect(phase.id).toBe(2);
    expect(phase.epics).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // 7. getTask throws EntityNotFoundError for missing id
  // -----------------------------------------------------------------------
  it("getTask throws EntityNotFoundError for unknown id", () => {
    mgr.init("plan.md", makeSamplePhases());

    expect(() => mgr.getTask("9.9.9")).toThrow(EntityNotFoundError);
  });

  it("getEpic throws EntityNotFoundError for unknown id", () => {
    mgr.init("plan.md", makeSamplePhases());

    expect(() => mgr.getEpic("9.9")).toThrow(EntityNotFoundError);
  });

  it("getPhase throws EntityNotFoundError for unknown id", () => {
    mgr.init("plan.md", makeSamplePhases());

    expect(() => mgr.getPhase(99)).toThrow(EntityNotFoundError);
  });

  it("getTask throws EntityNotFoundError when no state file exists", () => {
    expect(() => mgr.getTask("1.1.1")).toThrow(EntityNotFoundError);
  });

  it("getEpic throws EntityNotFoundError when no state file exists", () => {
    expect(() => mgr.getEpic("1.1")).toThrow(EntityNotFoundError);
  });

  it("getPhase throws EntityNotFoundError when no state file exists", () => {
    expect(() => mgr.getPhase(1)).toThrow(EntityNotFoundError);
  });

  it("EntityNotFoundError contains entity type and id", () => {
    mgr.init("plan.md", makeSamplePhases());

    try {
      mgr.getTask("9.9.9");
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(EntityNotFoundError);
      const enf = err as EntityNotFoundError;
      expect(enf.entityType).toBe("task");
      expect(enf.entityId).toBe("9.9.9");
    }
  });

  // -----------------------------------------------------------------------
  // 8. transition updates updated_at timestamp
  // -----------------------------------------------------------------------
  it("transition updates the updated_at timestamp", async () => {
    mgr.init("plan.md", makeSamplePhases());
    const before = mgr.load()!.updated_at;

    // Small delay to ensure timestamp differs
    await new Promise((resolve) => setTimeout(resolve, 10));

    mgr.transition("1.1.1", "doing");
    const after = mgr.load()!.updated_at;

    expect(new Date(after).getTime()).toBeGreaterThan(
      new Date(before).getTime(),
    );
  });

  // -----------------------------------------------------------------------
  // 9. load returns null when no state file exists
  // -----------------------------------------------------------------------
  it("load returns null when no state file exists", () => {
    const result = mgr.load();
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Additional: transition throws when no state exists
  // -----------------------------------------------------------------------
  it("transition throws EntityNotFoundError when no state exists", () => {
    expect(() => mgr.transition("1.1.1", "doing")).toThrow(
      EntityNotFoundError,
    );
  });

  it("transition throws EntityNotFoundError for unknown entity", () => {
    mgr.init("plan.md", makeSamplePhases());

    expect(() => mgr.transition("9.9.9", "doing")).toThrow(
      EntityNotFoundError,
    );
  });

  // -----------------------------------------------------------------------
  // Transitions to skipped
  // -----------------------------------------------------------------------
  it("transitions pending -> skipped", () => {
    mgr.init("plan.md", makeSamplePhases());
    const state = mgr.transition("1.1.1", "skipped");
    expect(state.phases[0].epics[0].tasks[0].status).toBe("skipped");
  });

  it("transitions doing -> skipped", () => {
    mgr.init("plan.md", makeSamplePhases());
    mgr.transition("1.1.1", "doing");
    const state = mgr.transition("1.1.1", "skipped");
    expect(state.phases[0].epics[0].tasks[0].status).toBe("skipped");
  });

  it("transitions failed -> skipped", () => {
    mgr.init("plan.md", makeSamplePhases());
    mgr.transition("1.1.1", "doing");
    mgr.transition("1.1.1", "failed");
    const state = mgr.transition("1.1.1", "skipped");
    expect(state.phases[0].epics[0].tasks[0].status).toBe("skipped");
  });

  it("transitions done -> skipped", () => {
    mgr.init("plan.md", makeSamplePhases());
    mgr.transition("1.1.1", "doing");
    mgr.transition("1.1.1", "done");
    const state = mgr.transition("1.1.1", "skipped");
    expect(state.phases[0].epics[0].tasks[0].status).toBe("skipped");
  });

  it("throws InvalidTransitionError for skipped -> doing (no outgoing edges)", () => {
    mgr.init("plan.md", makeSamplePhases());
    mgr.transition("1.1.1", "skipped");
    expect(() => mgr.transition("1.1.1", "doing")).toThrow(
      InvalidTransitionError,
    );
  });

  it("throws InvalidTransitionError for skipped -> pending", () => {
    mgr.init("plan.md", makeSamplePhases());
    mgr.transition("1.1.1", "skipped");
    expect(() => mgr.transition("1.1.1", "pending")).toThrow(
      InvalidTransitionError,
    );
  });

  // -----------------------------------------------------------------------
  // forceTransition
  // -----------------------------------------------------------------------
  it("forceTransition moves entity to any valid status", () => {
    mgr.init("plan.md", makeSamplePhases());
    // pending -> done is normally invalid, but force allows it
    const state = mgr.forceTransition("1.1.1", "done");
    expect(state.phases[0].epics[0].tasks[0].status).toBe("done");
  });

  it("forceTransition can un-skip an entity", () => {
    mgr.init("plan.md", makeSamplePhases());
    mgr.transition("1.1.1", "skipped");
    const state = mgr.forceTransition("1.1.1", "pending");
    expect(state.phases[0].epics[0].tasks[0].status).toBe("pending");
  });

  it("forceTransition works from any status", () => {
    mgr.init("plan.md", makeSamplePhases());

    // pending -> done (normally invalid)
    mgr.forceTransition("1.1.1", "done");
    expect(mgr.getTask("1.1.1").status).toBe("done");

    // done -> pending (normally invalid)
    mgr.forceTransition("1.1.1", "pending");
    expect(mgr.getTask("1.1.1").status).toBe("pending");

    // pending -> failed (normally invalid)
    mgr.forceTransition("1.1.1", "failed");
    expect(mgr.getTask("1.1.1").status).toBe("failed");
  });

  it("forceTransition throws EntityNotFoundError for unknown entity", () => {
    mgr.init("plan.md", makeSamplePhases());
    expect(() => mgr.forceTransition("9.9.9", "doing")).toThrow(
      EntityNotFoundError,
    );
  });

  it("forceTransition throws EntityNotFoundError when no state exists", () => {
    expect(() => mgr.forceTransition("1.1.1", "doing")).toThrow(
      EntityNotFoundError,
    );
  });

  // -----------------------------------------------------------------------
  // Constructor creates .rigor directory
  // -----------------------------------------------------------------------
  it("constructor creates .rigor directory if missing", () => {
    const freshDir = mkdtempSync(join(tmpdir(), "rigor-fresh-"));
    try {
      new StateManager(freshDir);
      expect(existsSync(join(freshDir, ".rigor"))).toBe(true);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// isValidTransition unit tests
// ---------------------------------------------------------------------------

describe("isValidTransition", () => {
  it("allows pending -> doing", () => {
    expect(isValidTransition("pending", "doing")).toBe(true);
  });

  it("allows doing -> done", () => {
    expect(isValidTransition("doing", "done")).toBe(true);
  });

  it("allows doing -> failed", () => {
    expect(isValidTransition("doing", "failed")).toBe(true);
  });

  it("allows failed -> doing", () => {
    expect(isValidTransition("failed", "doing")).toBe(true);
  });

  it("rejects pending -> done", () => {
    expect(isValidTransition("pending", "done")).toBe(false);
  });

  it("rejects pending -> failed", () => {
    expect(isValidTransition("pending", "failed")).toBe(false);
  });

  it("rejects done -> doing", () => {
    expect(isValidTransition("done", "doing")).toBe(false);
  });

  it("rejects done -> pending", () => {
    expect(isValidTransition("done", "pending")).toBe(false);
  });

  it("rejects done -> failed", () => {
    expect(isValidTransition("done", "failed")).toBe(false);
  });

  it("rejects same-status transition pending -> pending", () => {
    expect(isValidTransition("pending", "pending")).toBe(false);
  });

  it("rejects same-status transition doing -> doing", () => {
    expect(isValidTransition("doing", "doing")).toBe(false);
  });

  // skipped transitions
  it("allows pending -> skipped", () => {
    expect(isValidTransition("pending", "skipped")).toBe(true);
  });

  it("allows doing -> skipped", () => {
    expect(isValidTransition("doing", "skipped")).toBe(true);
  });

  it("allows failed -> skipped", () => {
    expect(isValidTransition("failed", "skipped")).toBe(true);
  });

  it("allows done -> skipped", () => {
    expect(isValidTransition("done", "skipped")).toBe(true);
  });

  it("rejects skipped -> doing (no outgoing edges)", () => {
    expect(isValidTransition("skipped", "doing")).toBe(false);
  });

  it("rejects skipped -> pending", () => {
    expect(isValidTransition("skipped", "pending")).toBe(false);
  });

  it("rejects skipped -> done", () => {
    expect(isValidTransition("skipped", "done")).toBe(false);
  });

  it("rejects skipped -> failed", () => {
    expect(isValidTransition("skipped", "failed")).toBe(false);
  });

  it("rejects skipped -> skipped", () => {
    expect(isValidTransition("skipped", "skipped")).toBe(false);
  });
});
