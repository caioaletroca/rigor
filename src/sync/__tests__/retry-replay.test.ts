import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SyncManager } from "../manager.js";
import type { SyncEvent, SyncEventType, SyncProvider } from "../schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  type: SyncEventType = "task_started",
  overrides: Partial<SyncEvent> = {},
): SyncEvent {
  return {
    type,
    entity_type: "task",
    entity_id: "1.1.1",
    cycle_id: "test-cycle",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function mockProvider(
  name: string,
  opts: {
    syncFn?: (event: SyncEvent) => Promise<void>;
  } = {},
): SyncProvider & { syncFn: ReturnType<typeof vi.fn> } {
  const syncFn = vi.fn(opts.syncFn ?? (async () => {}));
  return {
    name,
    sync: syncFn,
    syncFn,
  };
}

// ---------------------------------------------------------------------------
// Retry tests
// ---------------------------------------------------------------------------

describe("SyncManager.retry", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rigor-sync-retry-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("retries the last N events to a named provider", async () => {
    const provider = mockProvider("target");
    const manager = new SyncManager(tmpDir, [provider]);

    // Dispatch 5 events
    for (let i = 0; i < 5; i++) {
      await manager.dispatch(
        makeEvent("task_started", { entity_id: `1.1.${i}` }),
      );
    }
    provider.syncFn.mockClear();

    // Retry last 3
    const results = await manager.retry("target", 3);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
    expect(provider.syncFn).toHaveBeenCalledTimes(3);

    // Check it received the last 3 events
    const receivedIds = provider.syncFn.mock.calls.map(
      (call: [SyncEvent]) => call[0].entity_id,
    );
    expect(receivedIds).toEqual(["1.1.2", "1.1.3", "1.1.4"]);
  });

  it("returns error when provider not found", async () => {
    const manager = new SyncManager(tmpDir, []);
    const results = await manager.retry("nonexistent", 5);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain("not found");
  });

  it("handles retry when provider fails", async () => {
    const failing = mockProvider("failing", {
      syncFn: async () => {
        throw new Error("still broken");
      },
    });
    const manager = new SyncManager(tmpDir, [failing]);

    await manager.dispatch(makeEvent());
    failing.syncFn.mockClear();
    failing.syncFn.mockRejectedValue(new Error("still broken"));

    const results = await manager.retry("failing", 1);
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe("still broken");
  });
});

// ---------------------------------------------------------------------------
// Replay tests
// ---------------------------------------------------------------------------

describe("SyncManager.replay", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rigor-sync-replay-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("replays all journal events to a named provider", async () => {
    const original = mockProvider("original");
    const newProvider = mockProvider("new-provider");
    const manager = new SyncManager(tmpDir, [original, newProvider]);

    // Dispatch 3 events (both providers receive them)
    await manager.dispatch(makeEvent("cycle_initialized", { entity_type: "cycle" }));
    await manager.dispatch(makeEvent("task_started"));
    await manager.dispatch(makeEvent("task_completed"));
    newProvider.syncFn.mockClear();

    // Replay all events to the new provider
    const results = await manager.replay("new-provider");

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
    expect(newProvider.syncFn).toHaveBeenCalledTimes(3);

    // Events should be in order
    const types = newProvider.syncFn.mock.calls.map(
      (call: [SyncEvent]) => call[0].type,
    );
    expect(types).toEqual([
      "cycle_initialized",
      "task_started",
      "task_completed",
    ]);
  });

  it("returns error when provider not found", async () => {
    const manager = new SyncManager(tmpDir, []);
    const results = await manager.replay("nonexistent");

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain("not found");
  });

  it("returns empty results when journal is empty", async () => {
    const provider = mockProvider("p");
    const manager = new SyncManager(tmpDir, [provider]);

    const results = await manager.replay("p");
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Health tracking tests
// ---------------------------------------------------------------------------

describe("SyncManager health tracking", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rigor-sync-health-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("tracks success counts", async () => {
    const provider = mockProvider("tracked");
    const manager = new SyncManager(tmpDir, [provider]);

    await manager.dispatch(makeEvent());
    await manager.dispatch(makeEvent("task_completed"));

    const health = manager.getProviderHealth();
    expect(health).toHaveLength(1);
    expect(health[0].name).toBe("tracked");
    expect(health[0].total_dispatches).toBe(2);
    expect(health[0].successes).toBe(2);
    expect(health[0].failures).toBe(0);
    expect(health[0].consecutive_failures).toBe(0);
    expect(health[0].circuit_open).toBe(false);
  });

  it("tracks failure counts", async () => {
    const failing = mockProvider("failing", {
      syncFn: async () => {
        throw new Error("network error");
      },
    });
    const manager = new SyncManager(tmpDir, [failing]);

    await manager.dispatch(makeEvent());

    const health = manager.getProviderHealth();
    expect(health[0].failures).toBe(1);
    expect(health[0].consecutive_failures).toBe(1);
    expect(health[0].last_error).toBe("network error");
  });

  it("resets consecutive failures on success", async () => {
    let callCount = 0;
    const intermittent = mockProvider("intermittent", {
      syncFn: async () => {
        callCount++;
        if (callCount <= 2) throw new Error("temp failure");
      },
    });
    const manager = new SyncManager(tmpDir, [intermittent]);

    await manager.dispatch(makeEvent()); // fail
    await manager.dispatch(makeEvent()); // fail

    let health = manager.getProviderHealth();
    expect(health[0].consecutive_failures).toBe(2);

    await manager.dispatch(makeEvent()); // succeed

    health = manager.getProviderHealth();
    expect(health[0].consecutive_failures).toBe(0);
    expect(health[0].failures).toBe(2);
    expect(health[0].successes).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker tests
// ---------------------------------------------------------------------------

describe("SyncManager circuit breaker", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rigor-sync-circuit-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("disables provider after N consecutive failures", async () => {
    const failing = mockProvider("unreliable", {
      syncFn: async () => {
        throw new Error("always fails");
      },
    });
    // Set threshold to 3 for testing
    const manager = new SyncManager(tmpDir, [failing], undefined, 3);

    // 3 failures should trip the circuit
    await manager.dispatch(makeEvent());
    await manager.dispatch(makeEvent());
    await manager.dispatch(makeEvent());

    expect(manager.isProviderDisabled("unreliable")).toBe(true);

    const health = manager.getProviderHealth();
    expect(health[0].circuit_open).toBe(true);

    // Further dispatches should not reach the provider
    failing.syncFn.mockClear();
    await manager.dispatch(makeEvent());
    expect(failing.syncFn).not.toHaveBeenCalled();
  });

  it("re-enables provider via enableProvider()", async () => {
    const failing = mockProvider("unreliable", {
      syncFn: async () => {
        throw new Error("fails");
      },
    });
    const manager = new SyncManager(tmpDir, [failing], undefined, 2);

    await manager.dispatch(makeEvent());
    await manager.dispatch(makeEvent());

    expect(manager.isProviderDisabled("unreliable")).toBe(true);

    // Re-enable
    const result = manager.enableProvider("unreliable");
    expect(result).toBe(true);
    expect(manager.isProviderDisabled("unreliable")).toBe(false);

    const health = manager.getProviderHealth();
    expect(health[0].circuit_open).toBe(false);
    expect(health[0].consecutive_failures).toBe(0);
  });

  it("enableProvider returns false for already-active provider", () => {
    const provider = mockProvider("active");
    const manager = new SyncManager(tmpDir, [provider]);

    expect(manager.enableProvider("active")).toBe(false);
  });

  it("does not affect other providers when one is circuit-broken", async () => {
    const failing = mockProvider("bad", {
      syncFn: async () => {
        throw new Error("fails");
      },
    });
    const good = mockProvider("good");
    const manager = new SyncManager(tmpDir, [failing, good], undefined, 2);

    // Trip circuit on "bad"
    await manager.dispatch(makeEvent());
    await manager.dispatch(makeEvent());

    expect(manager.isProviderDisabled("bad")).toBe(true);
    expect(manager.isProviderDisabled("good")).toBe(false);

    // "good" should still receive events
    good.syncFn.mockClear();
    await manager.dispatch(makeEvent());
    expect(good.syncFn).toHaveBeenCalled();
  });
});
