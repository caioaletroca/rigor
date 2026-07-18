/**
 * Cycle state types and transition rules.
 *
 * Defines the full state tree: Cycle -> Phase -> Epic -> Task.
 * Also exports the valid status transition map and a guard function.
 */

// ---------------------------------------------------------------------------
// Status type and transitions
// ---------------------------------------------------------------------------

export type Status = "pending" | "doing" | "done" | "failed" | "skipped";

/**
 * Allowed status transitions.
 *
 * - pending -> doing    (work begins)
 * - pending -> skipped  (skip entity)
 * - doing   -> done     (work succeeds)
 * - doing   -> failed   (work fails)
 * - doing   -> skipped  (skip mid-work)
 * - failed  -> doing    (retry)
 * - failed  -> skipped  (skip after failure)
 * - done    -> skipped  (skip completed entity)
 *
 * `skipped` is a terminal status with no outgoing transitions.
 * Use `forceTransition` to un-skip an entity.
 */
export const VALID_TRANSITIONS: ReadonlyMap<Status, ReadonlySet<Status>> =
  new Map<Status, ReadonlySet<Status>>([
    ["pending", new Set<Status>(["doing", "skipped"])],
    ["doing", new Set<Status>(["done", "failed", "skipped"])],
    ["failed", new Set<Status>(["doing", "skipped"])],
    ["done", new Set<Status>(["skipped"])],
  ]);

/**
 * Set of all valid status values. Used by `forceTransition` to reject
 * arbitrary strings.
 */
export const ALL_STATUSES: ReadonlySet<Status> = new Set<Status>([
  "pending",
  "doing",
  "done",
  "failed",
  "skipped",
]);

/**
 * Returns true when `from -> to` is a permitted status transition.
 */
export function isValidTransition(from: Status, to: Status): boolean {
  const allowed = VALID_TRANSITIONS.get(from);
  if (!allowed) return false;
  return allowed.has(to);
}

// ---------------------------------------------------------------------------
// Gate evidence
// ---------------------------------------------------------------------------

export interface Gate0Evidence {
  passed: boolean;
  evidence_path?: string;
  coverage?: number;
  lint_passed?: boolean;
  tests_passed?: boolean;
}

export interface GateEvidence {
  passed: boolean;
  evidence_path?: string;
}

// ---------------------------------------------------------------------------
// Entity types
// ---------------------------------------------------------------------------

export interface TaskState {
  id: string;
  name: string;
  status: Status;
  gate_0: Gate0Evidence;
}

export interface EpicState {
  id: string;
  name: string;
  status: Status;
  tasks: TaskState[];
  gate_8: GateEvidence;
  gate_9: GateEvidence;
}

export interface PhaseState {
  id: number;
  status: Status;
  epics: EpicState[];
}

export interface CycleState {
  cycle_id: string;
  plan_path: string;
  current_phase: number;
  created_at: string;
  updated_at: string;
  phases: PhaseState[];
}
