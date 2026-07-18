/**
 * Sync event types and provider interface.
 *
 * Pure types plus the tiny `shouldDispatch` helper.
 * No heavy runtime logic lives here.
 */

import type { Status } from "../state/schema.js";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/**
 * All lifecycle events that the sync layer can emit.
 *
 * Mapping from Status transitions:
 *   pending -> doing  = *_started
 *   doing   -> done   = *_completed
 *   doing   -> failed = *_failed
 */
export type SyncEventType =
  | "cycle_initialized"
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "epic_started"
  | "epic_completed"
  | "epic_failed"
  | "phase_started"
  | "phase_completed"
  | "phase_failed";

/**
 * Entity types that can emit sync events.
 */
export type SyncEntityType = "cycle" | "phase" | "epic" | "task";

/**
 * A lifecycle event emitted by the state machine.
 */
export interface SyncEvent {
  type: SyncEventType;
  entity_type: SyncEntityType;
  entity_id: string;
  cycle_id: string;
  timestamp: string;
  previous_status?: Status;
  new_status?: Status;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * A sync provider receives lifecycle events and pushes them to
 * an external system (webhook, Jira, GitHub Projects, etc.).
 */
export interface SyncProvider {
  /** Unique name for this provider instance (e.g. "my-jira", "slack-hook"). */
  name: string;

  /**
   * Optional allowlist of event types this provider cares about.
   * When set, only matching events are dispatched.
   * When absent/empty, the provider receives all events.
   */
  events?: SyncEventType[];

  /** Push a single event to the external system. May throw on failure. */
  sync(event: SyncEvent): Promise<void>;
}

/**
 * Per-provider dispatch outcome.
 */
export interface SyncResult {
  provider: string;
  success: boolean;
  error?: string;
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the event should be dispatched to the provider.
 *
 * A provider with no `events` filter (or an empty array) receives everything.
 * Otherwise the event type must be in the allowlist.
 */
export function shouldDispatch(
  provider: SyncProvider,
  event: SyncEvent,
): boolean {
  if (!provider.events || provider.events.length === 0) {
    return true;
  }
  return provider.events.includes(event.type);
}

/**
 * Map a status transition to the corresponding SyncEventType.
 *
 * Returns undefined for transitions that don't map to a sync event
 * (e.g. failed -> doing is a retry, maps to *_started).
 */
export function transitionToEventType(
  entityType: SyncEntityType,
  toStatus: Status,
): SyncEventType | undefined {
  if (entityType === "cycle") return undefined;

  const suffix = statusToSuffix(toStatus);
  if (!suffix) return undefined;

  return `${entityType}_${suffix}` as SyncEventType;
}

function statusToSuffix(
  status: Status,
): "started" | "completed" | "failed" | undefined {
  switch (status) {
    case "doing":
      return "started";
    case "done":
      return "completed";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}
