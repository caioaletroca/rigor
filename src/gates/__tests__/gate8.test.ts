/**
 * Tests for Gate 8 exit-criteria logic.
 *
 * Pure functions — no mocking needed.
 */

import { describe, it, expect } from "vitest";
import { checkGate8Exit } from "../gate8.js";
import type { ReviewFindings } from "../gate8.js";
import type { RigorConfig } from "../../config/index.js";
import { DEFAULTS } from "../../config/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(
  overrides?: Partial<RigorConfig["gates"]["gate_8"]>,
): RigorConfig {
  return {
    ...DEFAULTS,
    gates: {
      ...DEFAULTS.gates,
      gate_8: {
        ...DEFAULTS.gates.gate_8,
        ...overrides,
      },
    },
  };
}

function makeSubmission(
  reviewer: string,
  verdict: "PASS" | "ISSUES_FOUND" = "PASS",
  findings: ReviewFindings["findings"] = [],
): ReviewFindings {
  return { reviewer, verdict, findings };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("checkGate8Exit", () => {
  // -----------------------------------------------------------------------
  // 1. Passes when all required reviewers submit with no critical/high findings
  // -----------------------------------------------------------------------
  it("passes when all required reviewers submit with no critical/high findings", () => {
    const config = makeConfig({
      required_reviewers: ["security", "logic"],
      max_critical_findings: 0,
      max_high_findings: 0,
    });

    const submissions: ReviewFindings[] = [
      makeSubmission("security"),
      makeSubmission("logic"),
      makeSubmission("code-quality"),
    ];

    const result = checkGate8Exit(submissions, config);

    expect(result.passed).toBe(true);
    expect(result.missing_reviewers).toHaveLength(0);
    expect(result.critical_count).toBe(0);
    expect(result.high_count).toBe(0);

    const reviewersCheck = result.checks.find(
      (c) => c.name === "required_reviewers_complete",
    );
    expect(reviewersCheck?.passed).toBe(true);

    const criticalCheck = result.checks.find(
      (c) => c.name === "critical_threshold",
    );
    expect(criticalCheck?.passed).toBe(true);

    const highCheck = result.checks.find((c) => c.name === "high_threshold");
    expect(highCheck?.passed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 2. Fails when required reviewer missing
  // -----------------------------------------------------------------------
  it("fails when a required reviewer is missing", () => {
    const config = makeConfig({
      required_reviewers: ["security", "logic"],
      max_critical_findings: 0,
      max_high_findings: 0,
    });

    const submissions: ReviewFindings[] = [
      makeSubmission("security"),
      // "logic" reviewer is missing
    ];

    const result = checkGate8Exit(submissions, config);

    expect(result.passed).toBe(false);
    expect(result.missing_reviewers).toContain("logic");

    const reviewersCheck = result.checks.find(
      (c) => c.name === "required_reviewers_complete",
    );
    expect(reviewersCheck?.passed).toBe(false);
    expect(reviewersCheck?.detail).toContain("logic");
  });

  // -----------------------------------------------------------------------
  // 3. Fails when critical findings exceed threshold
  // -----------------------------------------------------------------------
  it("fails when critical findings exceed threshold", () => {
    const config = makeConfig({
      required_reviewers: ["security"],
      max_critical_findings: 0,
      max_high_findings: 5,
    });

    const submissions: ReviewFindings[] = [
      makeSubmission("security", "ISSUES_FOUND", [
        {
          severity: "critical",
          file: "src/auth.ts",
          title: "SQL injection",
          description: "Unparameterized query",
          suggestion: "Use parameterized queries",
          source: "ai",
        },
      ]),
    ];

    const result = checkGate8Exit(submissions, config);

    expect(result.passed).toBe(false);
    expect(result.critical_count).toBe(1);

    const criticalCheck = result.checks.find(
      (c) => c.name === "critical_threshold",
    );
    expect(criticalCheck?.passed).toBe(false);
    expect(criticalCheck?.detail).toContain("exceeds");
  });

  // -----------------------------------------------------------------------
  // 4. Fails when high findings exceed threshold
  // -----------------------------------------------------------------------
  it("fails when high findings exceed threshold", () => {
    const config = makeConfig({
      required_reviewers: ["security"],
      max_critical_findings: 5,
      max_high_findings: 0,
    });

    const submissions: ReviewFindings[] = [
      makeSubmission("security", "ISSUES_FOUND", [
        {
          severity: "high",
          file: "src/handler.ts",
          title: "Missing error handling",
          description: "Unhandled promise rejection",
          suggestion: "Add try/catch",
          source: "ai",
        },
        {
          severity: "high",
          file: "src/db.ts",
          title: "Connection leak",
          description: "Connection not released",
          suggestion: "Use pool.release()",
          source: "tool:eslint",
        },
      ]),
    ];

    const result = checkGate8Exit(submissions, config);

    expect(result.passed).toBe(false);
    expect(result.high_count).toBe(2);

    const highCheck = result.checks.find((c) => c.name === "high_threshold");
    expect(highCheck?.passed).toBe(false);
    expect(highCheck?.detail).toContain("exceeds");
  });

  // -----------------------------------------------------------------------
  // 5. Non-required reviewer missing does not block
  // -----------------------------------------------------------------------
  it("passes when non-required reviewer is missing", () => {
    const config = makeConfig({
      reviewers: ["security", "logic", "code-quality", "test-quality"],
      required_reviewers: ["security"],
      max_critical_findings: 0,
      max_high_findings: 0,
    });

    const submissions: ReviewFindings[] = [
      makeSubmission("security"),
      // "logic", "code-quality", "test-quality" are not submitted
      // but they are not required
    ];

    const result = checkGate8Exit(submissions, config);

    expect(result.passed).toBe(true);
    expect(result.missing_reviewers).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 6. Design-quality reviewer submits and findings are counted
  // -----------------------------------------------------------------------
  it("counts design-quality reviewer findings in severity totals", () => {
    const config = makeConfig({
      reviewers: ["security", "design-quality"],
      required_reviewers: ["security"],
      max_critical_findings: 0,
      max_high_findings: 0,
    });

    const submissions: ReviewFindings[] = [
      makeSubmission("security"),
      makeSubmission("design-quality", "ISSUES_FOUND", [
        {
          severity: "high",
          file: "src/Button.tsx:12",
          title: "Hardcoded color bypasses design tokens",
          description: "Uses #7C3AED instead of var(--color-primary) from DESIGN.md",
          suggestion: "Replace with the design token: bg-brand-primary or var(--color-primary)",
          source: "tool:impeccable",
        },
        {
          severity: "medium",
          file: "src/Layout.tsx:45",
          title: "Inconsistent spacing between sections",
          description: "Gap between hero and features is 48px, but between features and CTA is 32px",
          suggestion: "Use consistent spacing from the design system spacing scale",
          source: "ai",
        },
      ]),
    ];

    const result = checkGate8Exit(submissions, config);

    // Gate fails because high_count (1) exceeds max_high_findings (0)
    expect(result.passed).toBe(false);
    expect(result.high_count).toBe(1);
    expect(result.critical_count).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 7. Design-quality reviewer is not in required_reviewers by default
  // -----------------------------------------------------------------------
  it("passes when design-quality reviewer is missing and not required", () => {
    const config = makeConfig({
      reviewers: ["security", "logic", "design-quality"],
      required_reviewers: ["security", "logic"],
      max_critical_findings: 0,
      max_high_findings: 0,
    });

    const submissions: ReviewFindings[] = [
      makeSubmission("security"),
      makeSubmission("logic"),
      // design-quality is not submitted but not required
    ];

    const result = checkGate8Exit(submissions, config);

    expect(result.passed).toBe(true);
    expect(result.missing_reviewers).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 8. Design-quality reviewer is in default reviewers list
  // -----------------------------------------------------------------------
  it("includes design-quality in default reviewers list", () => {
    expect(DEFAULTS.gates.gate_8.reviewers).toContain("design-quality");
  });

  // -----------------------------------------------------------------------
  // 9. Design-quality is NOT in default required_reviewers
  // -----------------------------------------------------------------------
  it("does not include design-quality in default required_reviewers", () => {
    expect(DEFAULTS.gates.gate_8.required_reviewers).not.toContain("design-quality");
  });
});
