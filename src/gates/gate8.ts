/**
 * Gate 8 exit-criteria enforcement.
 *
 * Validates that a code review was properly completed for an epic:
 * all required reviewers must submit, and finding counts must not
 * exceed configured thresholds.
 */

import type { RigorConfig } from "../config/index.js";
import type { CheckResult } from "../evidence/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  title: string;
  description: string;
  suggestion: string;
  source: string;
}

export interface ReviewFindings {
  reviewer: string;
  verdict: "PASS" | "ISSUES_FOUND";
  findings: ReviewFinding[];
}

export interface Gate8Result {
  passed: boolean;
  checks: CheckResult[];
  missing_reviewers: string[];
  critical_count: number;
  high_count: number;
}

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

/**
 * Evaluate Gate 8 exit criteria for an epic's code review.
 *
 * 1. Verifies all required reviewers have submitted.
 * 2. Counts critical and high findings across all submissions.
 * 3. Compares against configured thresholds.
 *
 * Overall result passes only when every individual check passes.
 */
export function checkGate8Exit(
  submissions: ReviewFindings[],
  config: RigorConfig,
): Gate8Result {
  const checks: CheckResult[] = [];

  const requiredReviewers = config.gates.gate_8.required_reviewers;
  const maxCritical = config.gates.gate_8.max_critical_findings;
  const maxHigh = config.gates.gate_8.max_high_findings;

  // -----------------------------------------------------------------------
  // 1. Required reviewers
  // -----------------------------------------------------------------------

  const submittedReviewers = new Set(submissions.map((s) => s.reviewer));
  const missingReviewers = requiredReviewers.filter(
    (r) => !submittedReviewers.has(r),
  );

  const reviewersComplete = missingReviewers.length === 0;

  checks.push({
    name: "required_reviewers_complete",
    passed: reviewersComplete,
    detail: reviewersComplete
      ? `All required reviewers submitted (${requiredReviewers.join(", ")})`
      : `Missing reviewers: ${missingReviewers.join(", ")}`,
  });

  // -----------------------------------------------------------------------
  // 2. Count findings by severity
  // -----------------------------------------------------------------------

  let criticalCount = 0;
  let highCount = 0;

  for (const submission of submissions) {
    for (const finding of submission.findings) {
      if (finding.severity === "critical") {
        criticalCount++;
      } else if (finding.severity === "high") {
        highCount++;
      }
    }
  }

  // -----------------------------------------------------------------------
  // 3. Critical threshold
  // -----------------------------------------------------------------------

  const criticalPassed = criticalCount <= maxCritical;

  checks.push({
    name: "critical_threshold",
    passed: criticalPassed,
    detail: criticalPassed
      ? `Critical findings: ${criticalCount} (max: ${maxCritical})`
      : `Critical findings: ${criticalCount} exceeds max ${maxCritical}`,
  });

  // -----------------------------------------------------------------------
  // 4. High threshold
  // -----------------------------------------------------------------------

  const highPassed = highCount <= maxHigh;

  checks.push({
    name: "high_threshold",
    passed: highPassed,
    detail: highPassed
      ? `High findings: ${highCount} (max: ${maxHigh})`
      : `High findings: ${highCount} exceeds max ${maxHigh}`,
  });

  // -----------------------------------------------------------------------
  // Overall
  // -----------------------------------------------------------------------

  const passed = checks.every((c) => c.passed);

  return {
    passed,
    checks,
    missing_reviewers: missingReviewers,
    critical_count: criticalCount,
    high_count: highCount,
  };
}
