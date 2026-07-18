/**
 * End-to-end test: config -> provider instantiation -> state transition ->
 * event dispatch -> HTTP delivery.
 *
 * Uses a real HTTP server (Node's http.createServer) to receive webhook calls.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer as createHttpServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import type { SyncEvent } from "../schema.js";
import { createProviders } from "../factory.js";
import { SyncManager } from "../manager.js";
import { StateManager } from "../../state/manager.js";
import { loadConfig } from "../../config/loader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
              name: "Define schema",
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

/**
 * Start a local HTTP server that collects POST bodies.
 * Returns the server instance, the port, and the collected events.
 */
async function startCollector(): Promise<{
  server: Server;
  port: number;
  events: SyncEvent[];
}> {
  const events: SyncEvent[] = [];

  const server = createHttpServer(
    (req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          events.push(JSON.parse(body) as SyncEvent);
        } catch {
          // ignore malformed
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
    },
  );

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port =
        typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({ server, port, events });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Sync E2E", () => {
  let tmpDir: string;
  let httpServer: Server;
  let port: number;
  let receivedEvents: SyncEvent[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "rigor-sync-e2e-"));
    const collector = await startCollector();
    httpServer = collector.server;
    port = collector.port;
    receivedEvents = collector.events;
  });

  afterEach(async () => {
    rmSync(tmpDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it("state transitions fire webhook calls end-to-end", async () => {
    // Write project config enabling sync with webhook pointed at local server
    const configDir = join(tmpDir, ".rigor");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.yaml"),
      `
sync:
  enabled: true
  primary: test-hook
  providers:
    test-hook:
      type: webhook
      url: http://127.0.0.1:${port}/events
`,
      "utf-8",
    );

    // Load config and build sync layer
    const config = loadConfig(tmpDir);
    expect(config.sync.enabled).toBe(true);

    const providers = createProviders(config.sync);
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe("test-hook");

    const syncManager = new SyncManager(
      tmpDir,
      providers,
      config.sync.primary,
    );
    const stateManager = new StateManager(tmpDir, syncManager);

    // Init cycle -> fires cycle_initialized
    stateManager.init("e2e-test-plan.md", makePhases());

    // Start task -> fires task_started
    stateManager.transition("1.1.1", "doing");

    // Complete task -> fires task_completed
    stateManager.transition("1.1.1", "done");

    // Wait for all async dispatches to complete
    await new Promise((r) => setTimeout(r, 500));

    // Verify HTTP server received events in order
    expect(receivedEvents.length).toBeGreaterThanOrEqual(3);
    expect(receivedEvents[0].type).toBe("cycle_initialized");
    expect(receivedEvents[1].type).toBe("task_started");
    expect(receivedEvents[1].entity_id).toBe("1.1.1");
    expect(receivedEvents[2].type).toBe("task_completed");
    expect(receivedEvents[2].entity_id).toBe("1.1.1");

    // Verify journal file exists with matching events
    const journalPath = join(tmpDir, ".rigor", "sync", "events.jsonl");
    expect(existsSync(journalPath)).toBe(true);

    const journalLines = readFileSync(journalPath, "utf-8")
      .trim()
      .split("\n");
    expect(journalLines.length).toBeGreaterThanOrEqual(3);

    const journalEvents = journalLines.map(
      (l) => JSON.parse(l) as SyncEvent,
    );
    expect(journalEvents[0].type).toBe("cycle_initialized");
    expect(journalEvents[1].type).toBe("task_started");
    expect(journalEvents[2].type).toBe("task_completed");
  });

  it("event filtering limits which events reach the webhook", async () => {
    const configDir = join(tmpDir, ".rigor");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.yaml"),
      `
sync:
  enabled: true
  providers:
    filtered-hook:
      type: webhook
      url: http://127.0.0.1:${port}/events
      events:
        - task_completed
`,
      "utf-8",
    );

    const config = loadConfig(tmpDir);
    const providers = createProviders(config.sync);
    const syncManager = new SyncManager(tmpDir, providers);
    const stateManager = new StateManager(tmpDir, syncManager);

    stateManager.init("filter-test.md", makePhases());
    stateManager.transition("1.1.1", "doing");
    stateManager.transition("1.1.1", "done");

    await new Promise((r) => setTimeout(r, 500));

    // Only task_completed should reach the HTTP server
    // (cycle_initialized and task_started should be filtered out)
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].type).toBe("task_completed");

    // But all events should be in the journal
    const journalEvents = syncManager.getJournalEvents();
    expect(journalEvents.length).toBeGreaterThanOrEqual(3);
  });
});
