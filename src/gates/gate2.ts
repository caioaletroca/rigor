/**
 * Gate 2 -- Accessibility gate (conditional).
 *
 * Ensures zero WCAG 2.1 AA violations for frontend projects.
 * Only runs when the project is detected as a React/Next.js frontend
 * (next.config.* or .tsx/.jsx files present).
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../executor/index.js";
import type { RigorConfig } from "../config/index.js";
import type { CheckResult } from "../evidence/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Gate2Result {
  passed: boolean;
  checks: CheckResult[];
  skipped: boolean;
  violation_count?: number;
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether this is a frontend project that needs accessibility checks.
 * Looks for next.config.* or any .tsx/.jsx files in the project root (shallow).
 */
function isFrontendProject(projectRoot: string): boolean {
  try {
    const entries = readdirSync(projectRoot);

    // Check for next.config.*
    if (entries.some((e) => e.startsWith("next.config"))) {
      return true;
    }

    // Check for .tsx or .jsx in src/ (if it exists)
    const srcDir = join(projectRoot, "src");
    if (existsSync(srcDir)) {
      return hasFrontendFiles(srcDir);
    }

    // Check for .tsx or .jsx in project root (flat projects)
    return entries.some((e) => e.endsWith(".tsx") || e.endsWith(".jsx"));
  } catch {
    return false;
  }
}

/**
 * Recursively check if a directory contains .tsx or .jsx files.
 * Limits depth to avoid scanning node_modules.
 */
function hasFrontendFiles(dir: string, depth = 0): boolean {
  if (depth > 3) return false;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;

      if (entry.isFile() && (entry.name.endsWith(".tsx") || entry.name.endsWith(".jsx"))) {
        return true;
      }

      if (entry.isDirectory() && depth < 3) {
        if (hasFrontendFiles(join(dir, entry.name), depth + 1)) {
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
 * Run Gate 2 exit checks -- accessibility validation for frontend projects.
 */
export function checkGate2Exit(
  config: RigorConfig,
  projectRoot: string,
): Gate2Result {
  // If Gate 2 is disabled, skip
  if (!config.gates.gate_2.enabled) {
    return {
      passed: true,
      checks: [
        { name: "gate_2", passed: true, detail: "Gate 2 disabled in config" },
      ],
      skipped: true,
    };
  }

  // Detect frontend project
  if (!isFrontendProject(projectRoot)) {
    return {
      passed: true,
      checks: [
        {
          name: "frontend_detection",
          passed: true,
          detail: "Not a frontend project (no next.config.* or .tsx/.jsx files) — skipping",
        },
      ],
      skipped: true,
    };
  }

  const checks: CheckResult[] = [];
  const a11yCommand = config.gates.gate_2.a11y_command;
  const maxViolations = config.gates.gate_2.max_violations;

  checks.push({
    name: "frontend_detection",
    passed: true,
    detail: "Frontend project detected",
  });

  // Run a11y command
  if (a11yCommand !== "") {
    const result = runCommand(a11yCommand, { cwd: projectRoot });
    const commandPassed = result.exit_code === 0;

    // Attempt to parse violation count from output
    const combined = result.stdout + result.stderr;
    let violationCount: number | undefined;

    const violationMatch = combined.match(/(\d+)\s*violation/i);
    if (violationMatch) {
      violationCount = parseInt(violationMatch[1], 10);
    }

    const passed = commandPassed && (violationCount === undefined || violationCount <= maxViolations);

    checks.push({
      name: "accessibility",
      passed,
      detail: passed
        ? violationCount !== undefined
          ? `Accessibility check passed (${violationCount} violations, max: ${maxViolations})`
          : "Accessibility check passed"
        : violationCount !== undefined
          ? `Accessibility check failed: ${violationCount} violations (max: ${maxViolations})`
          : `Accessibility check failed (exit code ${result.exit_code})`,
      command: a11yCommand,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
    });

    const allPassed = checks.every((c) => c.passed);

    return {
      passed: allPassed,
      checks,
      skipped: false,
      violation_count: violationCount,
    };
  }

  // No command configured
  checks.push({
    name: "accessibility",
    passed: true,
    detail: "No a11y command configured — gate 2 passes trivially",
  });

  return { passed: true, checks, skipped: false };
}
