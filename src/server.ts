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
import { StateManager } from "./state/index.js";
import { registerCycleTools } from "./tools/index.js";
import type { RigorConfig } from "./config/index.js";

// ---------------------------------------------------------------------------
// Server factory (testable)
// ---------------------------------------------------------------------------

export interface ServerContext {
  server: McpServer;
  stateManager: StateManager;
  config: RigorConfig;
}

/**
 * Create and configure the MCP server with all tools registered.
 *
 * This factory is separated from the transport layer so tests can
 * exercise tool registration without stdio.
 */
export function createServer(projectRoot: string): ServerContext {
  const config = loadConfig(projectRoot);
  const stateManager = new StateManager(projectRoot);

  const server = new McpServer(
    { name: "rigor-gate-server", version: "0.1.0" },
  );

  registerCycleTools(server, stateManager, config, projectRoot);

  return { server, stateManager, config };
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
