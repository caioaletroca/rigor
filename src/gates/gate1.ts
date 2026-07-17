/**
 * Gate 1 -- conditional infrastructure gate.
 *
 * Triggers when dependency manifests (package.json, go.mod, etc.) change
 * relative to a stored baseline. Runs an audit command to validate the
 * dependency tree is sound.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runCommand } from "../executor/index.js";
import type { RigorConfig } from "../config/index.js";
import type { CheckResult } from "../evidence/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Dependency manifest files to track. */
const DEP_FILES = [
  "package.json",
  "package-lock.json",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "requirements.txt",
  "pyproject.toml",
  "poetry.lock",
];

const BASELINE_DIR = ".rigor/baselines";
const BASELINE_FILE = "deps.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Gate1Result {
  passed: boolean;
  checks: CheckResult[];
  /** True when no dependency changes detected or gate is disabled. */
  skipped: boolean;
}

interface DepBaseline {
  hashes: Record<string, string>;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Hash the contents of a file. Returns null if the file does not exist.
 */
function hashFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf-8");
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Compute current dependency file hashes for the project.
 */
function currentHashes(projectRoot: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const file of DEP_FILES) {
    const hash = hashFile(join(projectRoot, file));
    if (hash !== null) {
      hashes[file] = hash;
    }
  }
  return hashes;
}

/**
 * Load the stored baseline. Returns null if no baseline exists.
 */
function loadBaseline(projectRoot: string): DepBaseline | null {
  const path = join(projectRoot, BASELINE_DIR, BASELINE_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DepBaseline;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Save a new baseline snapshot of dependency file hashes.
 */
export function saveBaseline(projectRoot: string): void {
  const dir = join(projectRoot, BASELINE_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const baseline: DepBaseline = {
    hashes: currentHashes(projectRoot),
    created_at: new Date().toISOString(),
  };
  writeFileSync(
    join(dir, BASELINE_FILE),
    JSON.stringify(baseline, null, 2),
  );
}

/**
 * Detect whether dependency files have changed since the baseline.
 * If no baseline exists, creates one and returns false (no changes).
 */
export function detectDependencyChanges(projectRoot: string): {
  changed: boolean;
  changedFiles: string[];
} {
  const baseline = loadBaseline(projectRoot);
  const current = currentHashes(projectRoot);

  if (baseline === null) {
    // First run -- create baseline, no changes to gate on
    saveBaseline(projectRoot);
    return { changed: false, changedFiles: [] };
  }

  const changedFiles: string[] = [];

  // Check for changed or new files
  for (const [file, hash] of Object.entries(current)) {
    if (baseline.hashes[file] !== hash) {
      changedFiles.push(file);
    }
  }

  // Check for removed files
  for (const file of Object.keys(baseline.hashes)) {
    if (!(file in current)) {
      changedFiles.push(file);
    }
  }

  return { changed: changedFiles.length > 0, changedFiles };
}

/**
 * Run Gate 1 exit checks -- infrastructure validation after dependency changes.
 */
export function checkGate1Exit(
  config: RigorConfig,
  projectRoot: string,
): Gate1Result {
  // If Gate 1 is disabled, skip
  if (!config.gates.gate_1.enabled) {
    return {
      passed: true,
      checks: [
        { name: "gate_1", passed: true, detail: "Gate 1 disabled in config" },
      ],
      skipped: true,
    };
  }

  // Detect dependency changes
  const { changed, changedFiles } = detectDependencyChanges(projectRoot);

  if (!changed) {
    return {
      passed: true,
      checks: [
        {
          name: "dependency_check",
          passed: true,
          detail: "No dependency changes detected",
        },
      ],
      skipped: true,
    };
  }

  const checks: CheckResult[] = [];

  checks.push({
    name: "dependency_changes",
    passed: true,
    detail: `Changed files: ${changedFiles.join(", ")}`,
  });

  // Run audit command if configured
  const auditCommand = config.gates.gate_1.audit_command;
  if (auditCommand !== "") {
    const result = runCommand(auditCommand, { cwd: projectRoot });
    const passed = result.exit_code === 0;

    checks.push({
      name: "audit",
      passed,
      detail: passed
        ? "Infrastructure audit passed"
        : `Infrastructure audit failed (exit code ${result.exit_code})`,
      command: auditCommand,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
    });
  }

  // Update baseline after successful check
  const allPassed = checks.every((c) => c.passed);
  if (allPassed) {
    saveBaseline(projectRoot);
  }

  return {
    passed: allPassed,
    checks,
    skipped: false,
  };
}
