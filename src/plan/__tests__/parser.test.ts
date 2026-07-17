import { describe, it, expect, afterAll } from "vitest";
import { join } from "node:path";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { parsePlan } from "../parser.js";
import { PlanParseError } from "../errors.js";

// ---------------------------------------------------------------------------
// Fixture path
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(import.meta.dirname, "fixtures");
const SAMPLE_PLAN = join(FIXTURE_DIR, "sample-plan.md");

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("parsePlan", () => {
  describe("header fields", () => {
    it("extracts the plan title from the H1 heading", () => {
      const plan = parsePlan(SAMPLE_PLAN);
      expect(plan.title).toBe("Sample Feature Implementation Plan");
    });

    it("extracts goal, architecture, and tech_stack", () => {
      const plan = parsePlan(SAMPLE_PLAN);
      expect(plan.goal).toBe(
        "Build a sample feature to validate the plan parser",
      );
      expect(plan.architecture).toContain("Simple layered architecture");
      expect(plan.tech_stack).toBe("TypeScript, Node.js 20+, vitest");
    });
  });

  // -------------------------------------------------------------------------
  // Phases
  // -------------------------------------------------------------------------

  describe("phases", () => {
    it("extracts the correct number of phases", () => {
      const plan = parsePlan(SAMPLE_PLAN);
      expect(plan.phases).toHaveLength(2);
    });

    it("Phase 1 has status Detailed, Phase 2 has Epic-level", () => {
      const plan = parsePlan(SAMPLE_PLAN);
      expect(plan.phases[0].status).toBe("Detailed");
      expect(plan.phases[1].status).toBe("Epic-level");
    });

    it("Phase 1 has correct milestone and epic ids", () => {
      const plan = parsePlan(SAMPLE_PLAN);
      const p1 = plan.phases[0];
      expect(p1.id).toBe(1);
      expect(p1.milestone).toBe(
        "Core service works end-to-end with tests",
      );
      expect(p1.epic_ids).toEqual(["1.1", "1.2"]);
    });

    it("Phase 2 has correct milestone and epic ids", () => {
      const plan = parsePlan(SAMPLE_PLAN);
      const p2 = plan.phases[1];
      expect(p2.id).toBe(2);
      expect(p2.milestone).toBe("Production hardening and monitoring");
      expect(p2.epic_ids).toEqual(["2.1"]);
    });
  });

  // -------------------------------------------------------------------------
  // Epics
  // -------------------------------------------------------------------------

  describe("epics", () => {
    it("Phase 1 has 2 epics, Phase 2 has 1 epic", () => {
      const plan = parsePlan(SAMPLE_PLAN);
      expect(plan.phases[0].epics).toHaveLength(2);
      expect(plan.phases[1].epics).toHaveLength(1);
    });

    it("extracts epic fields correctly", () => {
      const plan = parsePlan(SAMPLE_PLAN);
      const epic11 = plan.phases[0].epics[0];

      expect(epic11.id).toBe("1.1");
      expect(epic11.name).toBe("User service");
      expect(epic11.goal).toContain("GET /users/:id");
      expect(epic11.scope).toBe("`src/service/`, `src/handler/`");
      expect(epic11.dependencies).toBe("none");
      expect(epic11.done_when).toContain("integration test fetches a seeded user");
      expect(epic11.status).toBe("Pending");
    });

    it("extracts epic status when not Pending", () => {
      const plan = parsePlan(SAMPLE_PLAN);
      const epic12 = plan.phases[0].epics[1];
      expect(epic12.status).toBe("Doing");
    });

    it("Epic 2.1 is assigned to Phase 2", () => {
      const plan = parsePlan(SAMPLE_PLAN);
      const epic21 = plan.phases[1].epics[0];
      expect(epic21.id).toBe("2.1");
      expect(epic21.name).toBe("Observability and monitoring");
    });
  });

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  describe("tasks", () => {
    it("Epic 1.1 has 2 tasks", () => {
      const plan = parsePlan(SAMPLE_PLAN);
      const epic11 = plan.phases[0].epics[0];
      expect(epic11.tasks).toHaveLength(2);
    });

    it("Epic 1.2 has 1 task", () => {
      const plan = parsePlan(SAMPLE_PLAN);
      const epic12 = plan.phases[0].epics[1];
      expect(epic12.tasks).toHaveLength(1);
    });

    it("Epic 2.1 (epic-level only) has 0 tasks", () => {
      const plan = parsePlan(SAMPLE_PLAN);
      const epic21 = plan.phases[1].epics[0];
      expect(epic21.tasks).toHaveLength(0);
    });

    it("checked task has done=true, unchecked has done=false", () => {
      const plan = parsePlan(SAMPLE_PLAN);
      const tasks = plan.phases[0].epics[0].tasks;

      // Task 1.1.1 has [x] Done
      expect(tasks[0].id).toBe("1.1.1");
      expect(tasks[0].done).toBe(true);

      // Task 1.1.2 has [ ] Done
      expect(tasks[1].id).toBe("1.1.2");
      expect(tasks[1].done).toBe(false);
    });

    it("extracts task fields correctly", () => {
      const plan = parsePlan(SAMPLE_PLAN);
      const task = plan.phases[0].epics[0].tasks[0];

      expect(task.name).toBe("Implement GetUserByID service method");
      expect(task.context).toContain("UserRepository");
      expect(task.verification).toContain("npm test");
      expect(task.done_when).toContain("NotFoundError");
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("throws PlanParseError when file does not exist", () => {
      expect(() => parsePlan("/nonexistent/plan.md")).toThrow(PlanParseError);
      expect(() => parsePlan("/nonexistent/plan.md")).toThrow(
        "Plan file not found",
      );
    });

    it("throws PlanParseError when file has no Phase Overview table", () => {
      const noTable = join(FIXTURE_DIR, "no-table.md");
      writeFileSync(noTable, "# A Plan\n\nSome content but no table.\n");
      try {
        expect(() => parsePlan(noTable)).toThrow(PlanParseError);
        expect(() => parsePlan(noTable)).toThrow(
          "No Phase Overview table found",
        );
      } finally {
        unlinkSync(noTable);
      }
    });

    it("throws PlanParseError when file has no H1 title", () => {
      const noTitle = join(FIXTURE_DIR, "no-title.md");
      writeFileSync(
        noTitle,
        "## Phase Overview\n\n| Phase | Milestone | Epics | Status |\n|-------|-----------|-------|--------|\n| 1 | milestone | 1.1 | Detailed |\n",
      );
      try {
        expect(() => parsePlan(noTitle)).toThrow(PlanParseError);
        expect(() => parsePlan(noTitle)).toThrow("No title (H1) found");
      } finally {
        unlinkSync(noTitle);
      }
    });
  });
});
