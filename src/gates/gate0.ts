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

  // Track whether any check actually executed a command. An empty `checks`
  // array — or checks whose commands are all empty/unresolved (e.g. unresolved
  // ${lang.*} variables) — means nothing was verified.
  let ranAnyCommand = false;

  // -----------------------------------------------------------------------
  // Iterate generic checks
  // -----------------------------------------------------------------------

  for (const check of g0.checks) {
    // Skip checks with empty/unresolved commands (e.g. unresolved ${lang.*} variables).
    if (!check.command || check.command.trim() === "") {
      continue;
    }

    ranAnyCommand = true;
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
  // No runnable check — do NOT silently certify an unverified task.
  // -----------------------------------------------------------------------

  if (!ranAnyCommand) {
    if (g0.allow_empty) {
      return {
        passed: true,
        checks: [
          {
            name: "gate_0",
            passed: true,
            detail:
              "No runnable checks configured — passing because gates.gate_0.allow_empty is true.",
          },
        ],
      };
    }

    return {
      passed: false,
      checks: [
        {
          name: "gate_0",
          passed: false,
          detail:
            "No runnable Gate 0 checks (checks[] empty or all commands unresolved). " +
            "Refusing to certify an unverified task. Configure gates.gate_0.checks, " +
            "activate a domain/lang pack, or set gates.gate_0.allow_empty: true.",
        },
      ],
    };
  }

  // -----------------------------------------------------------------------
  // Test files: every newly-added source file must have a matching test in
  // the same changeset (see evaluateTestFiles).
  // -----------------------------------------------------------------------

  if (requireTestFiles) {
    checks.push(evaluateTestFiles(projectRoot));
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

const SOURCE_EXT = /\.(ts|tsx|js|jsx|go|py|cs|java|rs)$/;

/** A path that is itself a test file (by filename marker or a test directory). */
function isTestPath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return (
    /\.(test|spec)\.[a-z]+$/.test(base) ||
    /_test\.[a-z]+$/.test(base) ||
    /(^|\/)(__tests__|__test__|tests?)\//.test(path)
  );
}

/** Basename with directory and source extension stripped (e.g. src/a/foo.ts -> foo). */
function sourceStem(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(SOURCE_EXT, "");
}

/** Basename of a test file with test markers + extension stripped (foo.test.ts -> foo). */
function testStem(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base
    .replace(/\.(test|spec)\.[a-z]+$/, "")
    .replace(/_test\.[a-z]+$/, "")
    .replace(SOURCE_EXT, "");
}

/**
 * Enforce require_test_files: every newly-added (untracked or added) source
 * file in the working tree must have a matching test file present in the same
 * changeset, matched by basename stem. Modified files are not required to add
 * a test. Skips gracefully when git is unavailable / not a repo.
 */
export function evaluateTestFiles(projectRoot: string): CheckResult {
  const result = runCommand("git status --porcelain", { cwd: projectRoot });

  if (result.exit_code !== 0) {
    return {
      name: "test_files",
      passed: true,
      detail: "Skipped: not a git repository or git unavailable",
    };
  }

  const lines = String(result.stdout)
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.length > 0);

  const newSource: string[] = [];
  const testStems = new Set<string>();

  for (const line of lines) {
    const status = line.slice(0, 2);
    let path = line.slice(3).trim();
    if (path.includes(" -> ")) path = path.split(" -> ").pop()!.trim(); // rename target
    path = path.replace(/^"|"$/g, "");

    if (isTestPath(path)) {
      testStems.add(testStem(path));
      continue;
    }

    const isNew = status.includes("A") || status.includes("?");
    if (isNew && SOURCE_EXT.test(path)) {
      newSource.push(path);
    }
  }

  const uncovered = newSource.filter((s) => !testStems.has(sourceStem(s)));

  if (uncovered.length === 0) {
    return {
      name: "test_files",
      passed: true,
      detail:
        newSource.length === 0
          ? "No new source files requiring tests"
          : `All ${newSource.length} new source file(s) have a matching test`,
    };
  }

  return {
    name: "test_files",
    passed: false,
    detail: `New source files without a matching test in the changeset: ${uncovered.join(", ")}`,
  };
}
