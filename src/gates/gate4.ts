/**
 * Gate 4 -- E2E gate (conditional).
 *
 * Ensures end-to-end tests pass for frontend projects.
 * Only runs when e2e test files exist (e2e/**\/*.{ts,tsx} or **\/*.e2e.{ts,tsx}).
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../executor/index.js";
import type { RigorConfig } from "../config/index.js";
import type { CheckResult } from "../evidence/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Gate4Result {
  passed: boolean;
  checks: CheckResult[];
  skipped: boolean;
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

const E2E_TEST_PATTERN = /\.e2e\.(ts|tsx)$/;

/**
 * Check if a directory contains e2e test files.
 * Looks for:
 *   1. An `e2e/` directory at the project root with .ts/.tsx files
 *   2. Any *.e2e.{ts,tsx} files in the project tree
 */
function hasE2eTestFiles(projectRoot: string): boolean {
  // Check for e2e/ directory
  const e2eDir = join(projectRoot, "e2e");
  if (existsSync(e2eDir)) {
    if (hasTestFilesInDir(e2eDir, /\.(ts|tsx)$/)) {
      return true;
    }
  }

  // Check for *.e2e.{ts,tsx} files recursively
  return hasMatchingFiles(projectRoot, E2E_TEST_PATTERN);
}

/**
 * Check if a directory contains files matching a pattern.
 */
function hasTestFilesInDir(dir: string, pattern: RegExp, depth = 0): boolean {
  if (depth > 5) return false;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;

      if (entry.isFile() && pattern.test(entry.name)) {
        return true;
      }

      if (entry.isDirectory() && depth < 5) {
        if (hasTestFilesInDir(join(dir, entry.name), pattern, depth + 1)) {
          return true;
        }
      }
    }
  } catch {
    // Permission errors, etc.
  }

  return false;
}

/**
 * Recursively check for matching files, skipping common non-source dirs.
 */
function hasMatchingFiles(dir: string, pattern: RegExp, depth = 0): boolean {
  if (depth > 5) return false;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist") continue;

      if (entry.isFile() && pattern.test(entry.name)) {
        return true;
      }

      if (entry.isDirectory() && depth < 5) {
        if (hasMatchingFiles(join(dir, entry.name), pattern, depth + 1)) {
          return true;
        }
      }
    }
  } catch {
    // Permission errors, etc.
  }

  return false;
}

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

/**
 * Run Gate 4 exit checks -- end-to-end test validation.
 */
export function checkGate4Exit(
  config: RigorConfig,
  projectRoot: string,
): Gate4Result {
  // If Gate 4 is disabled, skip
  if (!config.gates.gate_4.enabled) {
    return {
      passed: true,
      checks: [
        { name: "gate_4", passed: true, detail: "Gate 4 disabled in config" },
      ],
      skipped: true,
    };
  }

  // Detect e2e test files
  if (!hasE2eTestFiles(projectRoot)) {
    return {
      passed: true,
      checks: [
        {
          name: "e2e_detection",
          passed: true,
          detail: "No e2e test files found (e2e/**/*.{ts,tsx}, *.e2e.{ts,tsx}) — skipping",
        },
      ],
      skipped: true,
    };
  }

  const checks: CheckResult[] = [];
  const e2eCommand = config.gates.gate_4.e2e_command;

  checks.push({
    name: "e2e_detection",
    passed: true,
    detail: "E2E test files detected",
  });

  // Run e2e command
  if (e2eCommand !== "") {
    const result = runCommand(e2eCommand, { cwd: projectRoot });
    const passed = result.exit_code === 0;

    checks.push({
      name: "e2e_tests",
      passed,
      detail: passed
        ? "E2E tests passed"
        : `E2E tests failed (exit code ${result.exit_code})`,
      command: e2eCommand,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
    });

    const allPassed = checks.every((c) => c.passed);

    return { passed: allPassed, checks, skipped: false };
  }

  // No command configured
  checks.push({
    name: "e2e_tests",
    passed: true,
    detail: "No e2e command configured — gate 4 passes trivially",
  });

  return { passed: true, checks, skipped: false };
}
