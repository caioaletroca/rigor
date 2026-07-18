import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  handleSyncStatus,
  handleSyncRetry,
  handleSyncReplay,
  handleSyncEnable,
} from "../sync.js";
import { SyncManager } from "../../sync/manager.js";
import type { SyncProvider, SyncEvent } from "../../sync/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockProvider(
  name: string,
  opts: { syncFn?: () => Promise<void> } = {},
): SyncProvider {
  return {
    name,
    sync: opts.syncFn ?? (async () => {}),
  };
}

function extractText(result: ReturnType<typeof handleSyncStatus>): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// sync_status
// ---------------------------------------------------------------------------

describe("sync_status tool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rigor-sync-tool-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns disabled message when syncManager is undefined", () => {
    const result = handleSyncStatus(undefined);
    const text = extractText(result);
    expect(text).toContain("Sync is not enabled");
  });

  it("returns sync status with provider info", () => {
    const manager = new SyncManager(
      tmpDir,
      [mockProvider("webhook-a"), mockProvider("jira-prod")],
      "jira-prod",
    );

    const result = handleSyncStatus(manager);
    const text = extractText(result);

    expect(text).toContain("Enabled: yes");
    expect(text).toContain("webhook-a, jira-prod");
    expect(text).toContain("Primary: jira-prod");
    expect(text).toContain("Events dispatched: 0");
    expect(text).toContain("Journal:");
  });

  it("shows event count after dispatches", async () => {
    const manager = new SyncManager(tmpDir, [mockProvider("p")]);

    await manager.dispatch({
      type: "task_started",
      entity_type: "task",
      entity_id: "1.1.1",
      cycle_id: "test",
      timestamp: new Date().toISOString(),
    });

    const result = handleSyncStatus(manager);
    const text = extractText(result);
    expect(text).toContain("Events dispatched: 1");
  });

  it("shows (not set) when no primary provider", () => {
    const manager = new SyncManager(tmpDir, [mockProvider("p")]);
    const result = handleSyncStatus(manager);
    const text = extractText(result);
    expect(text).toContain("Primary: (not set)");
  });

  it("shows (none) when no providers registered", () => {
    const manager = new SyncManager(tmpDir, []);
    const result = handleSyncStatus(manager);
    const text = extractText(result);
    expect(text).toContain("Providers: (none)");
  });

  it("shows per-provider health information", async () => {
    const manager = new SyncManager(tmpDir, [mockProvider("p1")]);

    await manager.dispatch({
      type: "task_started",
      entity_type: "task",
      entity_id: "1.1.1",
      cycle_id: "test",
      timestamp: new Date().toISOString(),
    });

    const result = handleSyncStatus(manager);
    const text = extractText(result);
    expect(text).toContain("Provider Health");
    expect(text).toContain("p1: active");
    expect(text).toContain("100% success");
  });

  it("shows circuit-open status for disabled providers", async () => {
    const failing = mockProvider("bad", {
      syncFn: async () => {
        throw new Error("fails");
      },
    });
    const manager = new SyncManager(tmpDir, [failing], undefined, 2);

    await manager.dispatch({
      type: "task_started",
      entity_type: "task",
      entity_id: "1.1.1",
      cycle_id: "test",
      timestamp: new Date().toISOString(),
    });
    await manager.dispatch({
      type: "task_completed",
      entity_type: "task",
      entity_id: "1.1.1",
      cycle_id: "test",
      timestamp: new Date().toISOString(),
    });

    const result = handleSyncStatus(manager);
    const text = extractText(result);
    expect(text).toContain("DISABLED (circuit open)");
  });
});

// ---------------------------------------------------------------------------
// sync_retry
// ---------------------------------------------------------------------------

describe("sync_retry tool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rigor-sync-retry-tool-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns disabled message when sync is off", async () => {
    const result = await handleSyncRetry(
      { provider: "p", count: 5 },
      undefined,
    );
    const text = extractText(result);
    expect(text).toContain("not enabled");
  });

  it("retries events and reports results", async () => {
    const provider = mockProvider("p1");
    const manager = new SyncManager(tmpDir, [provider]);

    await manager.dispatch({
      type: "task_started",
      entity_type: "task",
      entity_id: "1.1.1",
      cycle_id: "test",
      timestamp: new Date().toISOString(),
    });

    const result = await handleSyncRetry(
      { provider: "p1", count: 1 },
      manager,
    );
    const text = extractText(result);
    expect(text).toContain("Retry");
    expect(text).toContain("1 succeeded");
  });
});

// ---------------------------------------------------------------------------
// sync_replay
// ---------------------------------------------------------------------------

describe("sync_replay tool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rigor-sync-replay-tool-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns disabled message when sync is off", async () => {
    const result = await handleSyncReplay({ provider: "p" }, undefined);
    const text = extractText(result);
    expect(text).toContain("not enabled");
  });

  it("replays all events and reports results", async () => {
    const provider = mockProvider("p1");
    const manager = new SyncManager(tmpDir, [provider]);

    await manager.dispatch({
      type: "task_started",
      entity_type: "task",
      entity_id: "1.1.1",
      cycle_id: "test",
      timestamp: new Date().toISOString(),
    });
    await manager.dispatch({
      type: "task_completed",
      entity_type: "task",
      entity_id: "1.1.1",
      cycle_id: "test",
      timestamp: new Date().toISOString(),
    });

    const result = await handleSyncReplay({ provider: "p1" }, manager);
    const text = extractText(result);
    expect(text).toContain("Replay");
    expect(text).toContain("2 succeeded");
  });
});

// ---------------------------------------------------------------------------
// sync_enable
// ---------------------------------------------------------------------------

describe("sync_enable tool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rigor-sync-enable-tool-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns disabled message when sync is off", () => {
    const result = handleSyncEnable({ provider: "p" }, undefined);
    const text = extractText(result);
    expect(text).toContain("not enabled");
  });

  it("re-enables a disabled provider", async () => {
    const failing = mockProvider("bad", {
      syncFn: async () => {
        throw new Error("fails");
      },
    });
    const manager = new SyncManager(tmpDir, [failing], undefined, 2);

    // Trip circuit
    await manager.dispatch({
      type: "task_started",
      entity_type: "task",
      entity_id: "1.1.1",
      cycle_id: "test",
      timestamp: new Date().toISOString(),
    });
    await manager.dispatch({
      type: "task_completed",
      entity_type: "task",
      entity_id: "1.1.1",
      cycle_id: "test",
      timestamp: new Date().toISOString(),
    });

    const result = handleSyncEnable({ provider: "bad" }, manager);
    const text = extractText(result);
    expect(text).toContain("re-enabled");
  });

  it("reports when provider is already active", () => {
    const provider = mockProvider("good");
    const manager = new SyncManager(tmpDir, [provider]);

    const result = handleSyncEnable({ provider: "good" }, manager);
    const text = extractText(result);
    expect(text).toContain("already active");
  });

  it("reports when provider not found", () => {
    const manager = new SyncManager(tmpDir, []);

    const result = handleSyncEnable({ provider: "missing" }, manager);
    const text = extractText(result);
    expect(text).toContain("not found");
  });
});
