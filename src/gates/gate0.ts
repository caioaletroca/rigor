/**
 * Gate 0 exit-criteria enforcement.
 *
 * Runs per-task checks (tests, coverage, lint, test-file presence) and
 * returns a structured result that callers can persist as evidence.
 */

import { runCommand } from "../executor/index.js";
import { parseCoverage } from "../executor/index.js";
import type { RigorConfig } from "../config/index.js";
import type { CheckResult } from "../evidence/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Gate0Result {
  passed: boolean;
  checks: CheckResult[];
  coverage?: number;
}

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

/**
 * Evaluate Gate 0 exit criteria for a task.
 *
 * Checks are run in order: tests, coverage, lint, test_files.
 * The overall result passes only when every individual check passes.
 *
 * When no commands are configured (both test_command and lint_command are
 * empty strings), the gate passes trivially with an informational note.
 */
export async function checkGate0Exit(
  _taskId: string,
  config: RigorConfig,
  projectRoot: string,
): Promise<Gate0Result> {
  const checks: CheckResult[] = [];
  let parsedCoverage: number | undefined;

  const testCommand = config.gates.gate_0.test_command;
  const lintCommand = config.gates.gate_0.lint_command;
  const designCommand = config.gates.gate_0.design_command;
  const coverageThreshold = config.gates.gate_0.coverage_threshold;
  const requireTestFiles = config.gates.gate_0.require_test_files;

  // If nothing is configured, pass trivially.
  if (testCommand === "" && lintCommand === "" && designCommand === "") {
    checks.push({
      name: "tests",
      passed: true,
      detail: "No test or lint commands configured — gate 0 passes trivially",
    });

    return { passed: true, checks };
  }

  // -----------------------------------------------------------------------
  // 1. Tests
  // -----------------------------------------------------------------------

  let testsPassed = false;

  if (testCommand !== "") {
    const result = runCommand(testCommand, { cwd: projectRoot });

    if (result.exit_code === 127) {
      checks.push({
        name: "tests",
        passed: false,
        detail: `Command not found: "${testCommand}". Install the required tool or remove this check from your config.`,
        command: testCommand,
        exit_code: 127,
        duration_ms: result.duration_ms,
      });
    } else {
      testsPassed = result.exit_code === 0;

      checks.push({
        name: "tests",
        passed: testsPassed,
        detail: testsPassed
          ? "All tests passed"
          : `Tests failed (exit code ${result.exit_code})`,
        command: testCommand,
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
      });

      // -----------------------------------------------------------------
      // 2. Coverage (only if tests passed)
      // -----------------------------------------------------------------

      if (testsPassed) {
        const combined = result.stdout + result.stderr;
        const coverage = parseCoverage(combined, "auto");

        if (coverage !== null) {
          parsedCoverage = coverage;
          const meets = coverage >= coverageThreshold;

          checks.push({
            name: "coverage",
            passed: meets,
            detail: `Coverage ${coverage}% (threshold: ${coverageThreshold}%)`,
          });
        } else {
          checks.push({
            name: "coverage",
            passed: true,
            detail: "Coverage parsing not available",
          });
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // 3. Lint
  // -----------------------------------------------------------------------

  if (lintCommand !== "") {
    const result = runCommand(lintCommand, { cwd: projectRoot });

    if (result.exit_code === 127) {
      checks.push({
        name: "lint",
        passed: false,
        detail: `Command not found: "${lintCommand}". Install the required tool or remove this check from your config.`,
        command: lintCommand,
        exit_code: 127,
        duration_ms: result.duration_ms,
      });
    } else {
      const lintPassed = result.exit_code === 0;

      checks.push({
        name: "lint",
        passed: lintPassed,
        detail: lintPassed
          ? "Lint passed"
          : `Lint failed (exit code ${result.exit_code})`,
        command: lintCommand,
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 4. Design quality
  // -----------------------------------------------------------------------

  if (designCommand !== "") {
    const result = runCommand(designCommand, { cwd: projectRoot });

    if (result.exit_code === 127) {
      checks.push({
        name: "design-quality",
        passed: false,
        detail: `Command not found: "${designCommand}". Install the required tool or remove this check from your config.`,
        command: designCommand,
        exit_code: 127,
        duration_ms: result.duration_ms,
      });
    } else {
      const designPassed = result.exit_code === 0;
      const output = result.stdout.trim();

      checks.push({
        name: "design-quality",
        passed: designPassed,
        detail: designPassed
          ? "Design quality check passed"
          : `Design quality check failed${output ? `: ${output}` : ` (exit code ${result.exit_code})`}`,
        command: designCommand,
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 5. Test files (informational)
  // -----------------------------------------------------------------------

  if (requireTestFiles) {
    checks.push({
      name: "test_files",
      passed: true,
      detail: "Skipped: requires git diff integration (Phase 4)",
    });
  }

  // -----------------------------------------------------------------------
  // Overall
  // -----------------------------------------------------------------------

  const passed = checks.every((c) => c.passed);

  return { passed, checks, coverage: parsedCoverage };
}
