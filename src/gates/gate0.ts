/**
 * Gate 0 exit-criteria enforcement.
 *
 * Runs per-task checks (generic command checks with optional metrics,
 * plus test-file presence) and returns a structured result that callers
 * can persist as evidence.
 *
 * Supports both the new generic `checks[]` format and the legacy
 * `test_command` / `lint_command` / `coverage_threshold` fields via
 * automatic migration in the config loader.
 */

import { runCommand } from "../executor/index.js";
import { parseCoverage, parseMetric } from "../executor/index.js";
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
 * Iterates over `config.gates.gate_0.checks`, running each command and
 * optionally parsing a metric from its output. The overall result passes
 * only when every individual check passes.
 *
 * When no checks are configured, the gate passes trivially with an
 * informational note.
 */
export async function checkGate0Exit(
  _taskId: string,
  config: RigorConfig,
  projectRoot: string,
): Promise<Gate0Result> {
  const checks: CheckResult[] = [];
  let parsedCoverage: number | undefined;

  const g0 = config.gates.gate_0;
  const requireTestFiles = g0.require_test_files;

  // If nothing is configured, pass trivially.
  if (g0.checks.length === 0) {
    checks.push({
      name: "tests",
      passed: true,
      detail: "No test or lint commands configured — gate 0 passes trivially",
    });

    return { passed: true, checks };
  }

  // -----------------------------------------------------------------------
  // Iterate generic checks
  // -----------------------------------------------------------------------

  for (const check of g0.checks) {
    // Skip checks with empty/unresolved commands (e.g. unresolved ${lang.*} variables).
    if (!check.command || check.command.trim() === "") {
      continue;
    }

    const result = runCommand(check.command, { cwd: projectRoot });

    // Exit code 127 = command not found — provide a clear, actionable message.
    if (result.exit_code === 127) {
      checks.push({
        name: check.name,
        passed: false,
        detail: `Command not found: "${check.command}". Install the required tool or remove this check from your config.`,
        command: check.command,
        exit_code: 127,
        duration_ms: result.duration_ms,
      });
      continue;
    }

    const commandPassed = result.exit_code === 0;

    checks.push({
      name: check.name,
      passed: commandPassed,
      detail: commandPassed
        ? `${capitalize(check.name)} passed`
        : `${capitalize(check.name)} failed (exit code ${result.exit_code})`,
      command: check.command,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
    });

    // -----------------------------------------------------------------
    // Metric extraction (only if command passed)
    // -----------------------------------------------------------------

    if (commandPassed && check.metric) {
      const combined = result.stdout + result.stderr;
      const label = check.metric.label;
      let value: number | null;

      // Special "auto" parse mode uses the built-in coverage parsers.
      if (check.metric.parse === "auto") {
        value = parseCoverage(combined, "auto");
      } else {
        value = parseMetric(combined, check.metric.parse);
      }

      if (value !== null) {
        const meets = value >= check.metric.threshold;

        checks.push({
          name: label,
          passed: meets,
          detail: `${capitalize(label)} ${value}% (threshold: ${check.metric.threshold}%)`,
        });

        // Backward compat: populate the top-level coverage field.
        if (label === "coverage") {
          parsedCoverage = value;
        }
      } else {
        checks.push({
          name: label,
          passed: true,
          detail: `${capitalize(label)} parsing not available`,
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Test files (informational)
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
