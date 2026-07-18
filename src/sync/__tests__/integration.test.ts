import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "../../state/manager.js";
import { SyncManager } from "../manager.js";
import type { SyncEvent, SyncEventType, SyncProvider } from "../schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockProvider(
  name: string,
  opts: { events?: SyncEventType[] } = {},
): SyncProvider & { calls: SyncEvent[] } {
  const calls: SyncEvent[] = [];
  return {
    name,
    events: opts.events,
    calls,
    sync: async (event: SyncEvent) => {
      calls.push(structuredClone(event));
    },
  };
}

function makePhases() {
  return [
    {
      id: 1,
      status: "pending" as const,
      epics: [
        {
          id: "1.1",
          name: "Epic One",
          status: "pending" as const,
          tasks: [
            {
              id: "1.1.1",
              name: "Task A",
              status: "pending" as const,
              gate_0: { passed: false },
            },
            {
              id: "1.1.2",
              name: "Task B",
              status: "pending" as const,
              gate_0: { passed: false },
            },
          ],
          gate_8: { passed: false },
          gate_9: { passed: false },
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StateManager + SyncManager integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rigor-sync-integ-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("transition() dispatches events to a mock provider", async () => {
    const provider = mockProvider("test-provider");
    const syncManager = new SyncManager(tmpDir, [provider]);
    const stateManager = new StateManager(tmpDir, syncManager);

    stateManager.init("test-plan.md", makePhases());

    // Transition task to doing
    stateManager.transition("1.1.1", "doing");

    // Allow async dispatch to complete
    await new Promise((r) => setTimeout(r, 50));

    // Provider should have received cycle_initialized + task_started
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);
    expect(provider.calls[0].type).toBe("cycle_initialized");
    expect(provider.calls[1].type).toBe("task_started");
    expect(provider.calls[1].entity_id).toBe("1.1.1");
    expect(provider.calls[1].previous_status).toBe("pending");
    expect(provider.calls[1].new_status).toBe("doing");
  });

  it("init() fires cycle_initialized event", async () => {
    const provider = mockProvider("test-provider");
    const syncManager = new SyncManager(tmpDir, [provider]);
    const stateManager = new StateManager(tmpDir, syncManager);

    stateManager.init("test-plan.md", makePhases());
    await new Promise((r) => setTimeout(r, 50));

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].type).toBe("cycle_initialized");
    expect(provider.calls[0].entity_type).toBe("cycle");
  });

  it("works identically without syncManager (backward compat)", () => {
    const stateManager = new StateManager(tmpDir);
    const state = stateManager.init("test-plan.md", makePhases());
    expect(state.cycle_id).toBe("test-plan");

    const updated = stateManager.transition("1.1.1", "doing");
    expect(updated.phases[0].epics[0].tasks[0].status).toBe("doing");
  });

  it("sync failure does not block state transition", async () => {
    const failing: SyncProvider = {
      name: "failing",
      sync: async () => {
        throw new Error("provider crash");
      },
    };

    const syncManager = new SyncManager(tmpDir, [failing]);
    const stateManager = new StateManager(tmpDir, syncManager);

    stateManager.init("test-plan.md", makePhases());

    // This should NOT throw even though the provider crashes
    const state = stateManager.transition("1.1.1", "doing");
    expect(state.phases[0].epics[0].tasks[0].status).toBe("doing");

    await new Promise((r) => setTimeout(r, 50));
  });

  it("correctly infers entity types for events", async () => {
    const provider = mockProvider("test-provider");
    const syncManager = new SyncManager(tmpDir, [provider]);
    const stateManager = new StateManager(tmpDir, syncManager);

    stateManager.init("test-plan.md", makePhases());

    // Task transition
    stateManager.transition("1.1.1", "doing");
    await new Promise((r) => setTimeout(r, 50));

    const taskEvent = provider.calls.find((e) => e.type === "task_started");
    expect(taskEvent?.entity_type).toBe("task");

    // Complete the task
    stateManager.transition("1.1.1", "done");
    await new Promise((r) => setTimeout(r, 50));

    const completeEvent = provider.calls.find(
      (e) => e.type === "task_completed",
    );
    expect(completeEvent?.entity_type).toBe("task");
    expect(completeEvent?.entity_id).toBe("1.1.1");
  });

  it("journals events from state transitions", async () => {
    const provider = mockProvider("test-provider");
    const syncManager = new SyncManager(tmpDir, [provider]);
    const stateManager = new StateManager(tmpDir, syncManager);

    stateManager.init("test-plan.md", makePhases());
    stateManager.transition("1.1.1", "doing");
    await new Promise((r) => setTimeout(r, 50));

    // Journal should contain events
    expect(syncManager.getEventCount()).toBeGreaterThanOrEqual(2);
  });
});
