/**
 * Custom gate runner -- executes user-defined shell commands at lifecycle positions.
 */

import { runCommand } from "../executor/index.js";
import type { RigorConfig } from "../config/index.js";
import type { CustomGatePosition } from "../config/schema.js";
import type { CheckResult } from "../evidence/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomGateResult {
  passed: boolean;
  checks: CheckResult[];
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run all custom gates matching the given position.
 *
 * Returns `passed: true` if no gates match or all matching gates succeed.
 * A single failing command fails the entire set (short-circuit).
 */
export async function runCustomGates(
  position: CustomGatePosition,
  _entityId: string,
  config: RigorConfig,
  projectRoot: string,
): Promise<CustomGateResult> {
  const gates = config.gates.custom_gates.filter((g) => g.position === position);

  if (gates.length === 0) {
    return { passed: true, checks: [] };
  }

  const checks: CheckResult[] = [];

  for (const gate of gates) {
    const result = await runCommand(gate.command, {
      cwd: projectRoot,
      timeout_ms: gate.timeout_ms,
    });

    const passed = result.exit_code === 0;
    const detail = result.timed_out
      ? `Custom gate "${gate.name}" timed out`
      : result.cancelled
        ? `Custom gate "${gate.name}" was cancelled`
        : passed
          ? `Custom gate "${gate.name}" passed`
          : `Custom gate "${gate.name}" failed (exit code ${result.exit_code})`;

    checks.push({
      name: `custom:${gate.name}`,
      passed,
      detail,
      command: gate.command,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      timed_out: result.timed_out,
      cancelled: result.cancelled,
    });

    // Short-circuit: first failure stops remaining gates.
    if (!passed) {
      return { passed: false, checks };
    }
  }

  return { passed: true, checks };
}
