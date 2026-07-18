/**
 * Sync MCP tools: sync_status, sync_retry, sync_replay, sync_enable.
 *
 * Exposes sync layer state and management to MCP clients.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SyncManager } from "../sync/index.js";
import type { SyncResult } from "../sync/index.js";

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function textResult(text: string, isError?: boolean): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function formatResults(results: SyncResult[]): string {
  if (results.length === 0) return "No events processed.";

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;
  const lines: string[] = [
    `Results: ${succeeded} succeeded, ${failed} failed`,
  ];

  for (const r of results) {
    const status = r.success ? "OK" : "FAIL";
    const detail = r.error ? ` (${r.error})` : "";
    lines.push(`  [${status}] ${r.provider} (${r.duration_ms}ms)${detail}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleSyncStatus(
  syncManager?: SyncManager,
): CallToolResult {
  if (!syncManager) {
    return textResult(
      "Sync is not enabled. Configure sync in .rigor/config.yaml.",
    );
  }

  const providers = syncManager.getProviderNames();
  const primary = syncManager.getPrimaryName();
  const eventCount = syncManager.getEventCount();
  const journalPath = syncManager.getJournalPath();
  const health = syncManager.getProviderHealth();

  const lines: string[] = [
    "Sync Status",
    "===========",
    `Enabled: yes`,
    `Providers: ${providers.length > 0 ? providers.join(", ") : "(none)"}`,
    `Primary: ${primary ?? "(not set)"}`,
    `Events dispatched: ${eventCount}`,
    `Journal: ${journalPath}`,
  ];

  // Per-provider health
  if (health.length > 0) {
    lines.push("");
    lines.push("Provider Health");
    lines.push("--------------");
    for (const h of health) {
      const status = h.circuit_open ? "DISABLED (circuit open)" : "active";
      const successRate =
        h.total_dispatches > 0
          ? Math.round((h.successes / h.total_dispatches) * 100)
          : 100;
      lines.push(
        `  ${h.name}: ${status} | ${h.total_dispatches} dispatches, ` +
          `${successRate}% success, ${h.consecutive_failures} consecutive failures`,
      );
      if (h.last_error) {
        lines.push(`    Last error: ${h.last_error}`);
      }
    }
  }

  return textResult(lines.join("\n"));
}

export interface SyncRetryParams {
  provider: string;
  count: number;
}

export async function handleSyncRetry(
  params: SyncRetryParams,
  syncManager?: SyncManager,
): Promise<CallToolResult> {
  if (!syncManager) {
    return textResult("Sync is not enabled.", true);
  }

  const results = await syncManager.retry(params.provider, params.count);
  return textResult(
    `Retry: ${params.count} events to provider "${params.provider}"\n\n` +
      formatResults(results),
  );
}

export interface SyncReplayParams {
  provider: string;
}

export async function handleSyncReplay(
  params: SyncReplayParams,
  syncManager?: SyncManager,
): Promise<CallToolResult> {
  if (!syncManager) {
    return textResult("Sync is not enabled.", true);
  }

  const results = await syncManager.replay(params.provider);
  return textResult(
    `Replay: all journal events to provider "${params.provider}"\n\n` +
      formatResults(results),
  );
}

export interface SyncEnableParams {
  provider: string;
}

export function handleSyncEnable(
  params: SyncEnableParams,
  syncManager?: SyncManager,
): CallToolResult {
  if (!syncManager) {
    return textResult("Sync is not enabled.", true);
  }

  const wasDisabled = syncManager.enableProvider(params.provider);
  if (wasDisabled) {
    return textResult(
      `Provider "${params.provider}" has been re-enabled. Circuit breaker reset.`,
    );
  }

  if (syncManager.getProviderNames().includes(params.provider)) {
    return textResult(
      `Provider "${params.provider}" is already active (not disabled).`,
    );
  }

  return textResult(`Provider "${params.provider}" not found.`, true);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSyncTools(
  server: McpServer,
  syncManager?: SyncManager,
): void {
  server.tool("sync_status", {}, () => {
    return handleSyncStatus(syncManager);
  });

  server.tool(
    "sync_retry",
    {
      provider: z.string().describe("Name of the provider to retry events for"),
      count: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(5)
        .describe("Number of recent events to retry (default: 5)"),
    },
    async (params) => {
      return handleSyncRetry(params, syncManager);
    },
  );

  server.tool(
    "sync_replay",
    {
      provider: z
        .string()
        .describe("Name of the provider to replay all events to"),
    },
    async (params) => {
      return handleSyncReplay(params, syncManager);
    },
  );

  server.tool(
    "sync_enable",
    {
      provider: z
        .string()
        .describe(
          "Name of the provider to re-enable (after circuit breaker trip)",
        ),
    },
    (params) => {
      return handleSyncEnable(params, syncManager);
    },
  );
}
