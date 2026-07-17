/**
 * Gate 3 -- Visual Regression gate (conditional).
 *
 * Ensures snapshot/visual tests pass for frontend projects.
 * Only runs when visual test files exist (*.visual.{ts,tsx} or *.snapshot.{ts,tsx}).
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../executor/index.js";
import type { RigorConfig } from "../config/index.js";
import type { CheckResult } from "../evidence/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Gate3Result {
  passed: boolean;
  checks: CheckResult[];
  skipped: boolean;
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

const VISUAL_TEST_PATTERN = /\.(visual|snapshot)\.(ts|tsx)$/;

/**
 * Recursively check if a directory contains visual/snapshot test files.
 * Limits depth to avoid scanning node_modules.
 */
function hasVisualTestFiles(dir: string, depth = 0): boolean {
  if (depth > 5) return false;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist") continue;

      if (entry.isFile() && VISUAL_TEST_PATTERN.test(entry.name)) {
        return true;
      }

      if (entry.isDirectory() && depth < 5) {
        if (hasVisualTestFiles(join(dir, entry.name), depth + 1)) {
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
 * Run Gate 3 exit checks -- visual regression validation.
 */
export function checkGate3Exit(
  config: RigorConfig,
  projectRoot: string,
): Gate3Result {
  // If Gate 3 is disabled, skip
  if (!config.gates.gate_3.enabled) {
    return {
      passed: true,
      checks: [
        { name: "gate_3", passed: true, detail: "Gate 3 disabled in config" },
      ],
      skipped: true,
    };
  }

  // Detect visual test files
  if (!hasVisualTestFiles(projectRoot)) {
    return {
      passed: true,
      checks: [
        {
          name: "visual_detection",
          passed: true,
          detail: "No visual/snapshot test files found (*.visual.{ts,tsx}, *.snapshot.{ts,tsx}) — skipping",
        },
      ],
      skipped: true,
    };
  }

  const checks: CheckResult[] = [];
  const visualTestCommand = config.gates.gate_3.visual_test_command;

  checks.push({
    name: "visual_detection",
    passed: true,
    detail: "Visual/snapshot test files detected",
  });

  // Run visual test command
  if (visualTestCommand !== "") {
    const result = runCommand(visualTestCommand, { cwd: projectRoot });
    const passed = result.exit_code === 0;

    checks.push({
      name: "visual_regression",
      passed,
      detail: passed
        ? "Visual regression tests passed"
        : `Visual regression tests failed (exit code ${result.exit_code})`,
      command: visualTestCommand,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
    });

    const allPassed = checks.every((c) => c.passed);

    return { passed: allPassed, checks, skipped: false };
  }

  // No command configured
  checks.push({
    name: "visual_regression",
    passed: true,
    detail: "No visual test command configured — gate 3 passes trivially",
  });

  return { passed: true, checks, skipped: false };
}
