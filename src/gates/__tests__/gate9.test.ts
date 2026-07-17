/**
 * Tests for Gate 9 exit-criteria logic.
 *
 * Pure functions — no mocking needed.
 */

import { describe, it, expect } from "vitest";
import { checkGate9Exit } from "../gate9.js";
import type { AcceptanceCriterion } from "../gate9.js";
import type { RigorConfig } from "../../config/index.js";
import { DEFAULTS } from "../../config/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(
  overrides?: Partial<RigorConfig["gates"]["gate_9"]>,
): RigorConfig {
  return {
    ...DEFAULTS,
    gates: {
      ...DEFAULTS.gates,
      gate_9: {
        ...DEFAULTS.gates.gate_9,
        ...overrides,
      },
    },
  };
}

function makeCriterion(
  criterion: string,
  met: boolean,
  evidence = "Verified",
): AcceptanceCriterion {
  return { criterion, evidence, met };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("checkGate9Exit", () => {
  // -----------------------------------------------------------------------
  // 1. Passes when all criteria met and user approved
  // -----------------------------------------------------------------------
  it("passes when all criteria met and user approved", () => {
    const config = makeConfig({ require_user_approval: true });

    const criteria: AcceptanceCriterion[] = [
      makeCriterion("API returns 200 for valid request", true),
      makeCriterion("Error cases return proper status codes", true),
    ];

    const result = checkGate9Exit(criteria, true, config);

    expect(result.passed).toBe(true);
    expect(result.criteria_met).toBe(2);
    expect(result.criteria_total).toBe(2);
    expect(result.user_approved).toBe(true);

    const criteriaCheck = result.checks.find(
      (c) => c.name === "all_criteria_met",
    );
    expect(criteriaCheck?.passed).toBe(true);

    const approvalCheck = result.checks.find(
      (c) => c.name === "user_approval",
    );
    expect(approvalCheck?.passed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 2. Fails when criterion not met
  // -----------------------------------------------------------------------
  it("fails when a criterion is not met", () => {
    const config = makeConfig({ require_user_approval: false });

    const criteria: AcceptanceCriterion[] = [
      makeCriterion("API returns 200 for valid request", true),
      makeCriterion("Error cases return proper status codes", false, "Not yet implemented"),
    ];

    const result = checkGate9Exit(criteria, false, config);

    expect(result.passed).toBe(false);
    expect(result.criteria_met).toBe(1);
    expect(result.criteria_total).toBe(2);

    const criteriaCheck = result.checks.find(
      (c) => c.name === "all_criteria_met",
    );
    expect(criteriaCheck?.passed).toBe(false);
    expect(criteriaCheck?.detail).toContain("1/2");
    expect(criteriaCheck?.detail).toContain("Error cases");
  });

  // -----------------------------------------------------------------------
  // 3. Fails when user approval required but not given
  // -----------------------------------------------------------------------
  it("fails when user approval required but not given", () => {
    const config = makeConfig({ require_user_approval: true });

    const criteria: AcceptanceCriterion[] = [
      makeCriterion("API returns 200 for valid request", true),
    ];

    const result = checkGate9Exit(criteria, false, config);

    expect(result.passed).toBe(false);
    expect(result.user_approved).toBe(false);

    const approvalCheck = result.checks.find(
      (c) => c.name === "user_approval",
    );
    expect(approvalCheck?.passed).toBe(false);
    expect(approvalCheck?.detail).toContain("not given");
  });

  // -----------------------------------------------------------------------
  // 4. Passes without user approval when not required in config
  // -----------------------------------------------------------------------
  it("passes without user approval when not required in config", () => {
    const config = makeConfig({ require_user_approval: false });

    const criteria: AcceptanceCriterion[] = [
      makeCriterion("Feature works end-to-end", true),
    ];

    const result = checkGate9Exit(criteria, false, config);

    expect(result.passed).toBe(true);
    expect(result.criteria_met).toBe(1);
    expect(result.criteria_total).toBe(1);

    // No user_approval check should exist
    const approvalCheck = result.checks.find(
      (c) => c.name === "user_approval",
    );
    expect(approvalCheck).toBeUndefined();
  });
});
