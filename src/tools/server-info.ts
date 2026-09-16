import { resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { responseResult } from "./response.js";

export const RIGOR_SERVER_NAME = "rigor-gate-server";
export const RIGOR_SERVER_VERSION = "0.1.0";
export const RIGOR_SCHEMA_VERSION = 1;

export const ROOT_AWARE_LIFECYCLE_TOOLS = [
  "accept_start",
  "accept_submit",
  "cycle_diagnose",
  "cycle_init",
  "cycle_reload",
  "cycle_reset",
  "cycle_status",
  "epic_manage",
  "phase_advance",
  "phase_manage",
  "review_start",
  "review_submit",
  "sync_enable",
  "sync_replay",
  "sync_retry",
  "sync_status",
  "task_complete",
  "task_manage",
  "task_renew",
  "task_start",
] as const;

export const NON_LIFECYCLE_TOOLS = [
  "install_commands",
  "new_domain",
  "new_lang_pack",
  "rigor_status",
] as const;

export const REGISTERED_TOOL_NAMES = [
  ...ROOT_AWARE_LIFECYCLE_TOOLS,
  ...NON_LIFECYCLE_TOOLS,
].sort();

export interface ServerInfoParams {
  client_schema_version?: number;
}

export function handleServerInfo(params: ServerInfoParams, fallbackRoot: string): CallToolResult {
  const canonicalFallbackRoot = resolve(fallbackRoot);
  const reconnectRequired = params.client_schema_version !== undefined
    && params.client_schema_version < RIGOR_SCHEMA_VERSION;
  const status = {
    server_name: RIGOR_SERVER_NAME,
    server_version: RIGOR_SERVER_VERSION,
    schema_version: RIGOR_SCHEMA_VERSION,
    fallback_root: canonicalFallbackRoot,
    root_aware_lifecycle_tools: ROOT_AWARE_LIFECYCLE_TOOLS,
    reconnect_required: reconnectRequired,
  };
  return responseResult(JSON.stringify(status), {
    guidance: reconnectRequired ? ["Reconnect the MCP client to refresh its cached tool schema."] : undefined,
  });
}

export function registerServerInfoTool(server: McpServer, fallbackRoot: string): void {
  server.tool(
    "rigor_status",
    "Report live Rigor server capabilities and root-aware lifecycle tools",
    { client_schema_version: z.number().int().nonnegative().optional() },
    async (params) => handleServerInfo(params, fallbackRoot),
  );
}
