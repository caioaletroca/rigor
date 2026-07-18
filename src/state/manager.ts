/**
 * StateManager — reads, writes, and transitions cycle state.
 *
 * State is persisted as `.rigor/state.json` inside the project root.
 * Writes are atomic: data is flushed to a `.tmp` sibling then renamed.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { isValidTransition, ALL_STATUSES } from "./schema.js";
import { EntityNotFoundError, InvalidTransitionError } from "./errors.js";
import { validateState } from "./validator.js";
import type { ValidationResult } from "./validator.js";
import type {
  CycleState,
  EpicState,
  PhaseState,
  Status,
  TaskState,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RIGOR_DIR = ".rigor";
const STATE_FILE = "state.json";

// ---------------------------------------------------------------------------
// StateManager
// ---------------------------------------------------------------------------

export class StateManager {
  private readonly rigorDir: string;
  private readonly statePath: string;
  private readonly tmpPath: string;

  constructor(private readonly projectRoot: string) {
    this.rigorDir = join(projectRoot, RIGOR_DIR);
    this.statePath = join(this.rigorDir, STATE_FILE);
    this.tmpPath = join(this.rigorDir, `${STATE_FILE}.tmp`);

    if (!existsSync(this.rigorDir)) {
      mkdirSync(this.rigorDir, { recursive: true });
    }
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /**
   * Load cycle state from disk. Returns `null` when no state file exists.
   */
  load(): CycleState | null {
    if (!existsSync(this.statePath)) {
      return null;
    }

    const raw = readFileSync(this.statePath, "utf-8");
    return JSON.parse(raw) as CycleState;
  }

  /**
   * Load state and validate its integrity.
   * Returns both the state and validation results, or null when no
   * state file exists.
   */
  loadAndValidate(): {
    state: CycleState;
    validation: ValidationResult;
  } | null {
    const state = this.load();
    if (state === null) return null;

    const validation = validateState(state, this.projectRoot);
    return { state, validation };
  }

  /**
   * Persist cycle state to disk via atomic write (write .tmp, then rename).
   * Always stamps `updated_at` with the current ISO timestamp.
   */
  save(state: CycleState): void {
    state.updated_at = new Date().toISOString();
    const data = JSON.stringify(state, null, 2);
    writeFileSync(this.tmpPath, data, "utf-8");
    renameSync(this.tmpPath, this.statePath);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Create an initial cycle state from a plan path and pre-built phases.
   *
   * The `cycle_id` is derived from the plan file's basename without extension
   * (e.g., `docs/2026-07-16-mcp-server.md` -> `"2026-07-16-mcp-server"`).
   */
  init(planPath: string, phases: PhaseState[]): CycleState {
    const name = basename(planPath).replace(/\.[^.]+$/, "");
    const now = new Date().toISOString();

    const state: CycleState = {
      cycle_id: name,
      plan_path: planPath,
      current_phase: phases.length > 0 ? phases[0].id : 1,
      created_at: now,
      updated_at: now,
      phases,
    };

    this.save(state);
    return state;
  }

  // -----------------------------------------------------------------------
  // Transitions
  // -----------------------------------------------------------------------

  /**
   * Transition an entity (task, epic, or phase) to a new status.
   *
   * Looks up the entity by id across all phases, epics, and tasks.
   * Validates that the `from -> to` transition is allowed, throws
   * {@link InvalidTransitionError} otherwise.
   *
   * Returns the full updated cycle state after saving.
   */
  transition(entityId: string, toStatus: Status): CycleState {
    const state = this.load();
    if (state === null) {
      throw new EntityNotFoundError("cycle", entityId);
    }

    const entity = this.findEntity(state, entityId);
    if (!entity) {
      throw new EntityNotFoundError("entity", entityId);
    }

    if (!isValidTransition(entity.status, toStatus)) {
      throw new InvalidTransitionError(entityId, entity.status, toStatus);
    }

    entity.status = toStatus;
    this.save(state);
    return state;
  }

  /**
   * Force-transition an entity to any valid status, bypassing the
   * normal transition rules.
   *
   * Useful for un-skipping entities or administrative corrections.
   * Validates that `toStatus` is a member of the {@link Status} union.
   *
   * Returns the full updated cycle state after saving.
   */
  forceTransition(entityId: string, toStatus: Status): CycleState {
    if (!ALL_STATUSES.has(toStatus)) {
      throw new InvalidTransitionError(entityId, "unknown", toStatus);
    }

    const state = this.load();
    if (state === null) {
      throw new EntityNotFoundError("cycle", entityId);
    }

    const entity = this.findEntity(state, entityId);
    if (!entity) {
      throw new EntityNotFoundError("entity", entityId);
    }

    entity.status = toStatus;
    this.save(state);
    return state;
  }

  // -----------------------------------------------------------------------
  // Lookups
  // -----------------------------------------------------------------------

  /**
   * Find a task by id (e.g., "1.1.1"). Throws if not found.
   */
  getTask(taskId: string): TaskState {
    const state = this.load();
    if (state === null) {
      throw new EntityNotFoundError("task", taskId);
    }

    for (const phase of state.phases) {
      for (const epic of phase.epics) {
        for (const task of epic.tasks) {
          if (task.id === taskId) {
            return task;
          }
        }
      }
    }

    throw new EntityNotFoundError("task", taskId);
  }

  /**
   * Find an epic by id (e.g., "1.1"). Throws if not found.
   */
  getEpic(epicId: string): EpicState {
    const state = this.load();
    if (state === null) {
      throw new EntityNotFoundError("epic", epicId);
    }

    for (const phase of state.phases) {
      for (const epic of phase.epics) {
        if (epic.id === epicId) {
          return epic;
        }
      }
    }

    throw new EntityNotFoundError("epic", epicId);
  }

  /**
   * Find a phase by numeric id (e.g., 1). Throws if not found.
   */
  getPhase(phaseId: number): PhaseState {
    const state = this.load();
    if (state === null) {
      throw new EntityNotFoundError("phase", String(phaseId));
    }

    for (const phase of state.phases) {
      if (phase.id === phaseId) {
        return phase;
      }
    }

    throw new EntityNotFoundError("phase", String(phaseId));
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Walk the state tree to locate an entity by its string id.
   *
   * Matching order: phase (numeric string) -> epic -> task.
   */
  private findEntity(
    state: CycleState,
    entityId: string,
  ): { status: Status } | undefined {
    // Phase ids are numeric — try matching as integer first
    const asNumber = Number(entityId);
    if (Number.isInteger(asNumber)) {
      for (const phase of state.phases) {
        if (phase.id === asNumber) {
          return phase;
        }
      }
    }

    // Walk epics and tasks
    for (const phase of state.phases) {
      for (const epic of phase.epics) {
        if (epic.id === entityId) {
          return epic;
        }
        for (const task of epic.tasks) {
          if (task.id === entityId) {
            return task;
          }
        }
      }
    }

    return undefined;
  }
}
