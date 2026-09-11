#!/usr/bin/env node

/**
 * Rigor Gate Server -- MCP entry point.
 *
 * Starts a stdio-based MCP server that exposes cycle lifecycle tools,
 * gate enforcement, and state inspection.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config/index.js";
import { ProjectContextRegistry } from "./context.js";
import { StateManager } from "./state/index.js";
import { EvidenceManager } from "./evidence/index.js";
import { SyncManager } from "./sync/index.js";
import { createProviders } from "./sync/factory.js";
import {
  registerCycleTools,
  registerGateTools,
  registerReviewTools,
  registerRecoveryTools,
  registerSyncTools,
  registerScaffoldTools,
} from "./tools/index.js";
import type { RigorConfig } from "./config/index.js";

// ---------------------------------------------------------------------------
// Server factory (testable)
// ---------------------------------------------------------------------------

export interface ServerContext {
  server: McpServer;
  stateManager: StateManager;
  evidenceManager: EvidenceManager;
  syncManager?: SyncManager;
  registry: ProjectContextRegistry;
  config: RigorConfig;
}

/**
 * Create and configure the MCP server with all tools registered.
 *
 * This factory is separated from the transport layer so tests can
 * exercise tool registration without stdio.
 */
export function createServer(projectRoot: string, sharedRegistry?: ProjectContextRegistry): ServerContext {
  const config = loadConfig(projectRoot);

  // Build sync layer if enabled
  let syncManager: SyncManager | undefined;
  if (config.sync?.enabled) {
    const providers = createProviders(config.sync);
    syncManager = new SyncManager(
      projectRoot,
      providers,
      config.sync.primary,
    );
  }

  const registry = sharedRegistry ?? new ProjectContextRegistry(projectRoot, syncManager);
  const stateManager = registry.getByRoot(projectRoot).stateManager;
  const evidenceManager = registry.getByRoot(projectRoot).evidenceManager;

  const server = new McpServer(
    { name: "rigor-gate-server", version: "0.1.0" },
  );

  registerCycleTools(server, stateManager, config, projectRoot, registry);
  registerGateTools(server, stateManager, projectRoot, registry);
  registerReviewTools(server, stateManager, evidenceManager, projectRoot, registry);
  registerRecoveryTools(server, stateManager, evidenceManager, projectRoot, config, registry);
  registerSyncTools(server, syncManager, registry, projectRoot);
  registerScaffoldTools(server, projectRoot);

  return { server, stateManager, evidenceManager, syncManager, registry, config };
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): string {
  const idx = argv.indexOf("--project-root");
  if (idx !== -1 && idx + 1 < argv.length) {
    return argv[idx + 1];
  }
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const projectRoot = parseArgs(process.argv);
  const { server } = createServer(projectRoot);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`rigor-gate-server fatal: ${message}\n`);
  process.exit(1);
});
