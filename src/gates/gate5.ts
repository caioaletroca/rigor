/**
 * Gate 5 -- Performance gate (conditional).
 *
 * Ensures frontend performance meets thresholds.
 * Only runs when next.config.* exists or config explicitly enables it.
 */

import { readdirSync } from "node:fs";
import { runCommand } from "../executor/index.js";
import type { RigorConfig } from "../config/index.js";
import type { CheckResult } from "../evidence/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Gate5Result {
  passed: boolean;
  checks: CheckResult[];
  skipped: boolean;
  score?: number;
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether this project has a Next.js config file.
 */
function hasNextConfig(projectRoot: string): boolean {
  try {
    const entries = readdirSync(projectRoot);
    return entries.some((e) => e.startsWith("next.config"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

/**
 * Run Gate 5 exit checks -- performance validation.
 */
export function checkGate5Exit(
  config: RigorConfig,
  projectRoot: string,
): Gate5Result {
  // If Gate 5 is disabled, skip
  if (!config.gates.gate_5.enabled) {
    return {
      passed: true,
      checks: [
        { name: "gate_5", passed: true, detail: "Gate 5 disabled in config" },
      ],
      skipped: true,
    };
  }

  // Detect Next.js project (unless config explicitly wants this gate)
  if (!hasNextConfig(projectRoot)) {
    return {
      passed: true,
      checks: [
        {
          name: "perf_detection",
          passed: true,
          detail: "No next.config.* found — skipping performance gate",
        },
      ],
      skipped: true,
    };
  }

  const checks: CheckResult[] = [];
  const perfCommand = config.gates.gate_5.perf_command;
  const minScore = config.gates.gate_5.min_score;

  checks.push({
    name: "perf_detection",
    passed: true,
    detail: "Next.js project detected",
  });

  // Run performance command
  if (perfCommand !== "") {
    const budgetFile = config.gates.gate_5.budget_file;
    const fullCommand = budgetFile
      ? `${perfCommand} --budget-path=${budgetFile}`
      : perfCommand;

    const result = runCommand(fullCommand, { cwd: projectRoot });
    const commandPassed = result.exit_code === 0;

    // Attempt to parse performance score from output
    const combined = result.stdout + result.stderr;
    let parsedScore: number | undefined;

    // Common patterns: "Performance: 95", "score: 92", "Performance score: 88"
    const scoreMatch = combined.match(/(?:performance|score)[:\s]+(\d+)/i);
    if (scoreMatch) {
      parsedScore = parseInt(scoreMatch[1], 10);
    }

    const meetsThreshold = parsedScore === undefined || parsedScore >= minScore;
    const passed = commandPassed && meetsThreshold;

    checks.push({
      name: "performance",
      passed,
      detail: passed
        ? parsedScore !== undefined
          ? `Performance check passed (score: ${parsedScore}, min: ${minScore})`
          : "Performance check passed"
        : parsedScore !== undefined
          ? `Performance check failed: score ${parsedScore} below minimum ${minScore}`
          : `Performance check failed (exit code ${result.exit_code})`,
      command: fullCommand,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
    });

    const allPassed = checks.every((c) => c.passed);

    return {
      passed: allPassed,
      checks,
      skipped: false,
      score: parsedScore,
    };
  }

  // No command configured
  checks.push({
    name: "performance",
    passed: true,
    detail: "No performance command configured — gate 5 passes trivially",
  });

  return { passed: true, checks, skipped: false };
}
