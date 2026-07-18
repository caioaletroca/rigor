import { describe, it, expect } from "vitest";
import {
  shouldDispatch,
  transitionToEventType,
} from "../schema.js";
import type {
  SyncEvent,
  SyncEventType,
  SyncProvider,
} from "../schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(type: SyncEventType): SyncEvent {
  return {
    type,
    entity_type: "task",
    entity_id: "1.1.1",
    cycle_id: "test-cycle",
    timestamp: new Date().toISOString(),
  };
}

function makeProvider(
  name: string,
  events?: SyncEventType[],
): SyncProvider {
  return {
    name,
    events,
    sync: async () => {},
  };
}

// ---------------------------------------------------------------------------
// SyncEvent construction
// ---------------------------------------------------------------------------

describe("SyncEvent construction", () => {
  const allEventTypes: SyncEventType[] = [
    "cycle_initialized",
    "task_started",
    "task_completed",
    "task_failed",
    "epic_started",
    "epic_completed",
    "epic_failed",
    "phase_started",
    "phase_completed",
    "phase_failed",
  ];

  it.each(allEventTypes)("creates a valid event for type %s", (type) => {
    const event = makeEvent(type);
    expect(event.type).toBe(type);
    expect(event.entity_id).toBe("1.1.1");
    expect(event.cycle_id).toBe("test-cycle");
    expect(event.timestamp).toBeTruthy();
  });

  it("supports optional previous_status, new_status, and metadata", () => {
    const event: SyncEvent = {
      type: "task_started",
      entity_type: "task",
      entity_id: "1.1.1",
      cycle_id: "test-cycle",
      timestamp: new Date().toISOString(),
      previous_status: "pending",
      new_status: "doing",
      metadata: { task_name: "Define schema" },
    };

    expect(event.previous_status).toBe("pending");
    expect(event.new_status).toBe("doing");
    expect(event.metadata?.task_name).toBe("Define schema");
  });
});

// ---------------------------------------------------------------------------
// shouldDispatch
// ---------------------------------------------------------------------------

describe("shouldDispatch", () => {
  it("returns true when provider has no events filter", () => {
    const provider = makeProvider("all-events");
    const event = makeEvent("task_started");
    expect(shouldDispatch(provider, event)).toBe(true);
  });

  it("returns true when provider has empty events array", () => {
    const provider = makeProvider("empty-filter", []);
    const event = makeEvent("task_completed");
    expect(shouldDispatch(provider, event)).toBe(true);
  });

  it("returns true when event type is in the allowlist", () => {
    const provider = makeProvider("filtered", ["task_completed", "epic_completed"]);
    const event = makeEvent("task_completed");
    expect(shouldDispatch(provider, event)).toBe(true);
  });

  it("returns false when event type is not in the allowlist", () => {
    const provider = makeProvider("filtered", ["task_completed"]);
    const event = makeEvent("task_started");
    expect(shouldDispatch(provider, event)).toBe(false);
  });

  it("handles single-event filter", () => {
    const provider = makeProvider("single", ["cycle_initialized"]);
    expect(shouldDispatch(provider, makeEvent("cycle_initialized"))).toBe(true);
    expect(shouldDispatch(provider, makeEvent("task_started"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// transitionToEventType
// ---------------------------------------------------------------------------

describe("transitionToEventType", () => {
  it("maps doing -> *_started for all entity types", () => {
    expect(transitionToEventType("task", "doing")).toBe("task_started");
    expect(transitionToEventType("epic", "doing")).toBe("epic_started");
    expect(transitionToEventType("phase", "doing")).toBe("phase_started");
  });

  it("maps done -> *_completed for all entity types", () => {
    expect(transitionToEventType("task", "done")).toBe("task_completed");
    expect(transitionToEventType("epic", "done")).toBe("epic_completed");
    expect(transitionToEventType("phase", "done")).toBe("phase_completed");
  });

  it("maps failed -> *_failed for all entity types", () => {
    expect(transitionToEventType("task", "failed")).toBe("task_failed");
    expect(transitionToEventType("epic", "failed")).toBe("epic_failed");
    expect(transitionToEventType("phase", "failed")).toBe("phase_failed");
  });

  it("returns undefined for pending status", () => {
    expect(transitionToEventType("task", "pending")).toBeUndefined();
  });

  it("returns undefined for cycle entity type", () => {
    expect(transitionToEventType("cycle", "doing")).toBeUndefined();
  });
});
