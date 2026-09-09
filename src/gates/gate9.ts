/**
 * Gate 9 exit-criteria enforcement.
 *
 * Validates acceptance criteria for an epic: all criteria must be met,
 * and user approval is required when configured.
 */

import { z } from "zod";
import type { RigorConfig } from "../config/index.js";
import type { CheckResult } from "../evidence/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Runtime schema for the Gate 9 acceptance-criteria payload. Callers parse
 * untrusted JSON into this before evaluation so a missing `met` (or any
 * malformed item) is surfaced as an explicit schema error rather than being
 * silently coalesced to an unmet criterion. Shared with `review.ts` so both
 * sides agree on the per-item contract.
 */
export const Gate9Criteria = z
  .array(
    z.object({
      criterion: z.string(),
      evidence: z.string(),
      met: z.boolean(),
    }),
  )
  .min(1);

export type AcceptanceCriterion = z.infer<typeof Gate9Criteria>[number];

export interface Gate9Result {
  passed: boolean;
  checks: CheckResult[];
  criteria_met: number;
  criteria_total: number;
  user_approved: boolean;
}

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

/**
 * Evaluate Gate 9 exit criteria for an epic's acceptance.
 *
 * 1. Verifies all criteria are marked as met.
 * 2. If configured, verifies user approval was given.
 *
 * Overall result passes only when every individual check passes.
 */
export function checkGate9Exit(
  criteria: AcceptanceCriterion[],
  userApproved: boolean,
  config: RigorConfig,
): Gate9Result {
  const checks: CheckResult[] = [];

  // -----------------------------------------------------------------------
  // 1. All criteria met
  // -----------------------------------------------------------------------

  const criteriaMet = criteria.filter((c) => c.met).length;
  const criteriaTotal = criteria.length;
  const allMet = criteriaMet === criteriaTotal;

  const unmetCriteria = criteria.filter((c) => !c.met);

  checks.push({
    name: "all_criteria_met",
    passed: allMet,
    detail: allMet
      ? `All ${criteriaTotal} acceptance criteria met`
      : `${criteriaMet}/${criteriaTotal} criteria met. Unmet: ${unmetCriteria.map((c) => c.criterion).join("; ")}`,
  });

  // -----------------------------------------------------------------------
  // 2. User approval (if required)
  // -----------------------------------------------------------------------

  if (config.gates.gate_9.require_user_approval) {
    checks.push({
      name: "user_approval",
      passed: userApproved,
      detail: userApproved
        ? "User approval granted"
        : "User approval required but not given",
    });
  }

  // -----------------------------------------------------------------------
  // Overall
  // -----------------------------------------------------------------------

  const passed = checks.every((c) => c.passed);

  return {
    passed,
    checks,
    criteria_met: criteriaMet,
    criteria_total: criteriaTotal,
    user_approved: userApproved,
  };
}
