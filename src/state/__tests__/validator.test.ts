import { describe, it, expect } from "vitest";
import { validateState, detectStuckEntities } from "../validator.js";
import type { CycleState, PhaseState } from "../schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal valid CycleState for testing.
 * All statuses default to "pending", all gates default to not-passed.
 */
function makeValidState(overrides?: Partial<CycleState>): CycleState {
  return {
    cycle_id: "test-cycle",
    plan_path: "docs/plan.md",
    current_phase: 1,
    created_at: "2026-07-17T00:00:00.000Z",
    updated_at: "2026-07-17T00:00:00.000Z",
    phases: [
      {
        id: 1,
        status: "pending",
        epics: [
          {
            id: "1.1",
            name: "Setup",
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
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateState
// ---------------------------------------------------------------------------

describe("validateState", () => {
  // -----------------------------------------------------------------------
  // Valid state
  // -----------------------------------------------------------------------
  it("returns valid: true with no errors for a valid state", () => {
    const state = makeValidState();
    const result = validateState(state);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Missing required fields
  // -----------------------------------------------------------------------
  it("reports error for missing cycle_id", () => {
    const state = makeValidState({ cycle_id: "" });
    const result = validateState(state);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing cycle_id");
  });

  it("reports error for missing plan_path", () => {
    const state = makeValidState({ plan_path: "" });
    const result = validateState(state);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing plan_path");
  });

  it("reports error when phases is not an array", () => {
    const state = makeValidState();
    // Force phases to a non-array value for structural validation
    (state as Record<string, unknown>).phases = "not-an-array";
    const result = validateState(state);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("phases is not an array");
  });

  // -----------------------------------------------------------------------
  // current_phase validation
  // -----------------------------------------------------------------------
  it("reports error when current_phase not found in phases", () => {
    const state = makeValidState({ current_phase: 99 });
    const result = validateState(state);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("current_phase 99"))).toBe(
      true,
    );
  });

  // -----------------------------------------------------------------------
  // Invalid status values
  // -----------------------------------------------------------------------
  it("reports error for invalid phase status", () => {
    const state = makeValidState();
    (state.phases[0] as Record<string, unknown>).status = "running";
    const result = validateState(state);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes("Phase") && e.includes("invalid status"),
      ),
    ).toBe(true);
  });

  it("reports error for invalid epic status", () => {
    const state = makeValidState();
    (state.phases[0].epics[0] as Record<string, unknown>).status = "cancelled";
    const result = validateState(state);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes("Epic") && e.includes("invalid status"),
      ),
    ).toBe(true);
  });

  it("reports error for invalid task status", () => {
    const state = makeValidState();
    (state.phases[0].epics[0].tasks[0] as Record<string, unknown>).status =
      "unknown";
    const result = validateState(state);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes("Task") && e.includes("invalid status"),
      ),
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Duplicate ids
  // -----------------------------------------------------------------------
  it("reports error for duplicate phase id", () => {
    const state = makeValidState();
    state.phases[1].id = 1; // same as phases[0]
    const result = validateState(state);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("Duplicate phase id")),
    ).toBe(true);
  });

  it("reports error for duplicate epic id", () => {
    const state = makeValidState();
    state.phases[1].epics[0].id = "1.1"; // same as phases[0].epics[0]
    const result = validateState(state);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("Duplicate epic id")),
    ).toBe(true);
  });

  it("reports error for duplicate task id", () => {
    const state = makeValidState();
    state.phases[0].epics[0].tasks[1].id = "1.1.1"; // same as tasks[0]
    const result = validateState(state);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("Duplicate task id")),
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // ID format warnings
  // -----------------------------------------------------------------------
  it("warns when epic id does not match N.N format", () => {
    const state = makeValidState();
    state.phases[0].epics[0].id = "bad-id";
    const result = validateState(state);

    // Format warnings are not errors
    expect(result.valid).toBe(true);
    expect(
      result.warnings.some(
        (w) => w.includes("bad-id") && w.includes("format"),
      ),
    ).toBe(true);
  });

  it("warns when task id does not match N.N.N format", () => {
    const state = makeValidState();
    state.phases[0].epics[0].tasks[0].id = "task-x";
    const result = validateState(state);

    expect(result.valid).toBe(true);
    expect(
      result.warnings.some(
        (w) => w.includes("task-x") && w.includes("format"),
      ),
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Consistency: done status vs gate evidence
  // -----------------------------------------------------------------------
  it("warns when done task has gate_0.passed = false", () => {
    const state = makeValidState();
    state.phases[0].epics[0].tasks[0].status = "done";
    state.phases[0].epics[0].tasks[0].gate_0.passed = false;
    const result = validateState(state);

    expect(
      result.warnings.some(
        (w) => w.includes("1.1.1") && w.includes("gate_0 not passed"),
      ),
    ).toBe(true);
  });

  it("warns when done epic has gate_8 not passed", () => {
    const state = makeValidState();
    state.phases[0].epics[0].status = "done";
    state.phases[0].epics[0].gate_8.passed = false;
    const result = validateState(state);

    expect(
      result.warnings.some(
        (w) => w.includes("1.1") && w.includes("gate_8 not passed"),
      ),
    ).toBe(true);
  });

  it("warns when done epic has gate_9 not passed", () => {
    const state = makeValidState();
    state.phases[0].epics[0].status = "done";
    state.phases[0].epics[0].gate_8.passed = true;
    state.phases[0].epics[0].gate_9.passed = false;
    const result = validateState(state);

    expect(
      result.warnings.some(
        (w) => w.includes("1.1") && w.includes("gate_9 not passed"),
      ),
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Evidence path checks (with projectRoot)
  // -----------------------------------------------------------------------
  it("warns when task evidence path does not exist on disk", () => {
    const state = makeValidState();
    state.phases[0].epics[0].tasks[0].gate_0.evidence_path =
      "/nonexistent/path/evidence.json";
    const result = validateState(state, "/tmp");

    expect(
      result.warnings.some(
        (w) => w.includes("1.1.1") && w.includes("evidence file not found"),
      ),
    ).toBe(true);
  });

  it("warns when epic gate_8 evidence path does not exist on disk", () => {
    const state = makeValidState();
    state.phases[0].epics[0].gate_8.evidence_path =
      "/nonexistent/path/review.json";
    const result = validateState(state, "/tmp");

    expect(
      result.warnings.some(
        (w) =>
          w.includes("1.1") && w.includes("gate_8 evidence file not found"),
      ),
    ).toBe(true);
  });

  it("warns when epic gate_9 evidence path does not exist on disk", () => {
    const state = makeValidState();
    state.phases[0].epics[0].gate_9.evidence_path =
      "/nonexistent/path/acceptance.json";
    const result = validateState(state, "/tmp");

    expect(
      result.warnings.some(
        (w) =>
          w.includes("1.1") && w.includes("gate_9 evidence file not found"),
      ),
    ).toBe(true);
  });

  it("does not check evidence paths when projectRoot is not provided", () => {
    const state = makeValidState();
    state.phases[0].epics[0].tasks[0].gate_0.evidence_path =
      "/nonexistent/path/evidence.json";
    const result = validateState(state);

    // No warnings about evidence files when projectRoot is omitted
    expect(
      result.warnings.some((w) => w.includes("evidence file not found")),
    ).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Epics array validation
  // -----------------------------------------------------------------------
  it("reports error when epics is not an array", () => {
    const state = makeValidState();
    (state.phases[0] as Record<string, unknown>).epics = "not-an-array";
    const result = validateState(state);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("epics is not an array")),
    ).toBe(true);
  });

  it("reports error when tasks is not an array", () => {
    const state = makeValidState();
    (state.phases[0].epics[0] as Record<string, unknown>).tasks =
      "not-an-array";
    const result = validateState(state);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("tasks is not an array")),
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Multiple errors accumulated
  // -----------------------------------------------------------------------
  it("accumulates multiple errors in a single pass", () => {
    const state = makeValidState({ cycle_id: "", plan_path: "" });
    const result = validateState(state);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    expect(result.errors).toContain("Missing cycle_id");
    expect(result.errors).toContain("Missing plan_path");
  });

  // -----------------------------------------------------------------------
  // Early return when phases is not an array
  // -----------------------------------------------------------------------
  it("returns early with errors when phases is not an array", () => {
    const state = makeValidState();
    (state as Record<string, unknown>).phases = null;
    const result = validateState(state);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("phases is not an array");
    // Should not have iterated deeper
    expect(result.errors.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// detectStuckEntities
// ---------------------------------------------------------------------------

describe("detectStuckEntities", () => {
  it("returns empty array when no entities are stuck", () => {
    const state: CycleState = {
      cycle_id: "test",
      plan_path: "plan.md",
      current_phase: 1,
      created_at: "2026-07-17T00:00:00.000Z",
      updated_at: "2026-07-17T00:00:00.000Z",
      phases: [
        {
          id: 1,
          status: "pending",
          epics: [
            {
              id: "1.1",
              name: "Setup",
              status: "pending",
              tasks: [
                {
                  id: "1.1.1",
                  name: "Init",
                  status: "pending",
                  gate_0: { passed: false },
                },
              ],
              gate_8: { passed: false },
              gate_9: { passed: false },
            },
          ],
        },
      ],
    };

    const stuck = detectStuckEntities(state);
    expect(stuck).toHaveLength(0);
  });

  it("detects task stuck in doing", () => {
    const state: CycleState = {
      cycle_id: "test",
      plan_path: "plan.md",
      current_phase: 1,
      created_at: "2026-07-17T00:00:00.000Z",
      updated_at: "2026-07-17T00:00:00.000Z",
      phases: [
        {
          id: 1,
          status: "pending",
          epics: [
            {
              id: "1.1",
              name: "Setup",
              status: "pending",
              tasks: [
                {
                  id: "1.1.1",
                  name: "Init",
                  status: "doing",
                  gate_0: { passed: false },
                },
              ],
              gate_8: { passed: false },
              gate_9: { passed: false },
            },
          ],
        },
      ],
    };

    const stuck = detectStuckEntities(state);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toEqual({ id: "1.1.1", type: "task", name: "Init" });
  });

  it("detects epic stuck in doing", () => {
    const state: CycleState = {
      cycle_id: "test",
      plan_path: "plan.md",
      current_phase: 1,
      created_at: "2026-07-17T00:00:00.000Z",
      updated_at: "2026-07-17T00:00:00.000Z",
      phases: [
        {
          id: 1,
          status: "pending",
          epics: [
            {
              id: "1.1",
              name: "Setup",
              status: "doing",
              tasks: [
                {
                  id: "1.1.1",
                  name: "Init",
                  status: "pending",
                  gate_0: { passed: false },
                },
              ],
              gate_8: { passed: false },
              gate_9: { passed: false },
            },
          ],
        },
      ],
    };

    const stuck = detectStuckEntities(state);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toEqual({ id: "1.1", type: "epic", name: "Setup" });
  });

  it("does NOT flag current_phase as stuck even if doing", () => {
    const state: CycleState = {
      cycle_id: "test",
      plan_path: "plan.md",
      current_phase: 1,
      created_at: "2026-07-17T00:00:00.000Z",
      updated_at: "2026-07-17T00:00:00.000Z",
      phases: [
        {
          id: 1,
          status: "doing",
          epics: [
            {
              id: "1.1",
              name: "Setup",
              status: "pending",
              tasks: [
                {
                  id: "1.1.1",
                  name: "Init",
                  status: "pending",
                  gate_0: { passed: false },
                },
              ],
              gate_8: { passed: false },
              gate_9: { passed: false },
            },
          ],
        },
      ],
    };

    const stuck = detectStuckEntities(state);
    // Phase 1 is current_phase, so "doing" is normal
    const phaseStuck = stuck.filter((s) => s.type === "phase");
    expect(phaseStuck).toHaveLength(0);
  });

  it("flags non-current phase stuck in doing", () => {
    const state: CycleState = {
      cycle_id: "test",
      plan_path: "plan.md",
      current_phase: 2,
      created_at: "2026-07-17T00:00:00.000Z",
      updated_at: "2026-07-17T00:00:00.000Z",
      phases: [
        {
          id: 1,
          status: "doing",
          epics: [
            {
              id: "1.1",
              name: "Setup",
              status: "pending",
              tasks: [
                {
                  id: "1.1.1",
                  name: "Init",
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
          status: "doing",
          epics: [
            {
              id: "2.1",
              name: "Features",
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
      ],
    };

    const stuck = detectStuckEntities(state);
    // Phase 1 is NOT current (2 is), so phase 1 "doing" is stuck
    const phaseStuck = stuck.filter((s) => s.type === "phase");
    expect(phaseStuck).toHaveLength(1);
    expect(phaseStuck[0].id).toBe("1");
    expect(phaseStuck[0].name).toBe("Phase 1");
  });

  it("detects multiple stuck entities across the tree", () => {
    const state: CycleState = {
      cycle_id: "test",
      plan_path: "plan.md",
      current_phase: 1,
      created_at: "2026-07-17T00:00:00.000Z",
      updated_at: "2026-07-17T00:00:00.000Z",
      phases: [
        {
          id: 1,
          status: "doing",
          epics: [
            {
              id: "1.1",
              name: "Setup",
              status: "doing",
              tasks: [
                {
                  id: "1.1.1",
                  name: "Init",
                  status: "doing",
                  gate_0: { passed: false },
                },
                {
                  id: "1.1.2",
                  name: "Config",
                  status: "doing",
                  gate_0: { passed: false },
                },
              ],
              gate_8: { passed: false },
              gate_9: { passed: false },
            },
          ],
        },
      ],
    };

    const stuck = detectStuckEntities(state);
    // Phase 1 is current, so not stuck. But epic and 2 tasks are stuck.
    expect(stuck).toHaveLength(3);

    const types = stuck.map((s) => s.type);
    expect(types).toContain("epic");
    expect(types).toContain("task");

    const ids = stuck.map((s) => s.id);
    expect(ids).toContain("1.1");
    expect(ids).toContain("1.1.1");
    expect(ids).toContain("1.1.2");
  });
});
