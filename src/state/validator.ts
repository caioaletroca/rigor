/**
 * State validation and corruption detection.
 *
 * Checks structural integrity of CycleState and detects
 * entities stuck in "doing" status (likely from a crash).
 */

import { existsSync } from "node:fs";
import type { CycleState } from "./schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "doing",
  "done",
  "failed",
  "skipped",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface StuckEntity {
  id: string;
  type: "phase" | "epic" | "task";
  name: string;
}

// ---------------------------------------------------------------------------
// validateState
// ---------------------------------------------------------------------------

/**
 * Validate the structural integrity of a CycleState object.
 *
 * Checks:
 * 1. All status values are valid enum members
 * 2. Phase/epic/task ids follow expected formats
 * 3. current_phase exists in the phases array
 * 4. Evidence paths point to files that exist on disk
 * 5. No duplicate entity ids
 * 6. "done" tasks have gate_0.passed = true (consistency)
 */
export function validateState(
  state: CycleState,
  projectRoot?: string,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seenIds = new Set<string>();

  // Check required top-level fields
  if (!state.cycle_id) {
    errors.push("Missing cycle_id");
  }
  if (!state.plan_path) {
    errors.push("Missing plan_path");
  }
  if (!Array.isArray(state.phases)) {
    errors.push("phases is not an array");
    return { valid: false, errors, warnings };
  }

  // Check current_phase exists
  const phaseIds = state.phases.map((p) => p.id);
  if (!phaseIds.includes(state.current_phase)) {
    errors.push(
      `current_phase ${state.current_phase} not found in phases [${phaseIds.join(", ")}]`,
    );
  }

  for (const phase of state.phases) {
    const phaseKey = String(phase.id);

    // Duplicate check
    if (seenIds.has(phaseKey)) {
      errors.push(`Duplicate phase id: ${phaseKey}`);
    }
    seenIds.add(phaseKey);

    // Status check
    if (!VALID_STATUSES.has(phase.status)) {
      errors.push(`Phase ${phaseKey}: invalid status "${phase.status}"`);
    }

    if (!Array.isArray(phase.epics)) {
      errors.push(`Phase ${phaseKey}: epics is not an array`);
      continue;
    }

    for (const epic of phase.epics) {
      // ID format check (should be like "1.1")
      if (!/^\d+\.\d+$/.test(epic.id)) {
        warnings.push(
          `Epic "${epic.id}": id does not match expected format N.N`,
        );
      }

      // Duplicate check
      if (seenIds.has(epic.id)) {
        errors.push(`Duplicate epic id: ${epic.id}`);
      }
      seenIds.add(epic.id);

      // Status check
      if (!VALID_STATUSES.has(epic.status)) {
        errors.push(`Epic ${epic.id}: invalid status "${epic.status}"`);
      }

      // Evidence path checks (only if projectRoot provided)
      if (projectRoot) {
        if (
          epic.gate_8.evidence_path &&
          !existsSync(epic.gate_8.evidence_path)
        ) {
          warnings.push(
            `Epic ${epic.id}: gate_8 evidence file not found: ${epic.gate_8.evidence_path}`,
          );
        }
        if (
          epic.gate_9.evidence_path &&
          !existsSync(epic.gate_9.evidence_path)
        ) {
          warnings.push(
            `Epic ${epic.id}: gate_9 evidence file not found: ${epic.gate_9.evidence_path}`,
          );
        }
      }

      // Consistency: done epic should have gate_8 and gate_9 passed
      if (epic.status === "done") {
        if (!epic.gate_8.passed) {
          warnings.push(
            `Epic ${epic.id}: status is "done" but gate_8 not passed`,
          );
        }
        if (!epic.gate_9.passed) {
          warnings.push(
            `Epic ${epic.id}: status is "done" but gate_9 not passed`,
          );
        }
      }

      if (!Array.isArray(epic.tasks)) {
        errors.push(`Epic ${epic.id}: tasks is not an array`);
        continue;
      }

      for (const task of epic.tasks) {
        // ID format check (should be like "1.1.1")
        if (!/^\d+\.\d+\.\d+$/.test(task.id)) {
          warnings.push(
            `Task "${task.id}": id does not match expected format N.N.N`,
          );
        }

        // Duplicate check
        if (seenIds.has(task.id)) {
          errors.push(`Duplicate task id: ${task.id}`);
        }
        seenIds.add(task.id);

        // Status check
        if (!VALID_STATUSES.has(task.status)) {
          errors.push(`Task ${task.id}: invalid status "${task.status}"`);
        }

        // Evidence path check
        if (
          projectRoot &&
          task.gate_0.evidence_path &&
          !existsSync(task.gate_0.evidence_path)
        ) {
          warnings.push(
            `Task ${task.id}: gate_0 evidence file not found: ${task.gate_0.evidence_path}`,
          );
        }

        // Consistency: done task should have gate_0.passed
        if (task.status === "done" && !task.gate_0.passed) {
          warnings.push(
            `Task ${task.id}: status is "done" but gate_0 not passed`,
          );
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// detectStuckEntities
// ---------------------------------------------------------------------------

/**
 * Detect entities stuck in "doing" status.
 *
 * Entities left in "doing" typically indicate a crash or interruption
 * mid-operation. Returns entity ids with their type and name.
 */
export function detectStuckEntities(state: CycleState): StuckEntity[] {
  const stuck: StuckEntity[] = [];

  for (const phase of state.phases) {
    if (phase.status === "doing") {
      // A "doing" phase is normal if it's the current phase.
      // Only flag non-current phases stuck in "doing".
      if (phase.id !== state.current_phase) {
        stuck.push({
          id: String(phase.id),
          type: "phase",
          name: `Phase ${phase.id}`,
        });
      }
    }

    for (const epic of phase.epics) {
      if (epic.status === "doing") {
        stuck.push({ id: epic.id, type: "epic", name: epic.name });
      }

      for (const task of epic.tasks) {
        if (task.status === "doing") {
          stuck.push({ id: task.id, type: "task", name: task.name });
        }
      }
    }
  }

  return stuck;
}
