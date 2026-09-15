import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StateManager } from "../state/index.js";
import type { EvidenceManager } from "../evidence/index.js";
import type { RigorConfig } from "../config/index.js";
import { projectRootSchema, resolveRequestContext } from "./lifecycle.js";
import type { ProjectContextRegistry } from "../context.js";
import { handleCycleReset, handleTaskManage, handleEpicManage, handlePhaseManage, handleCycleDiagnose } from "../services/recovery-lifecycle.js";

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerRecoveryTools(
  server: McpServer,
  stateManager: StateManager,
  evidenceManager: EvidenceManager,
  projectRoot: string,
  config: RigorConfig,
  registry?: ProjectContextRegistry,
): void {

  server.tool(
    "cycle_reset",
    "Preview or reset the current cycle — deletes state and evidence files",
    { confirm: z.boolean().describe("Set to true to actually delete; false for preview"), project_root: projectRootSchema },
    async (params) => {
      const ctx = resolveRequestContext(registry, stateManager, projectRoot, params.project_root);
       return handleCycleReset(params, ctx?.stateManager ?? stateManager, ctx?.evidenceManager ?? evidenceManager, ctx?.project_root ?? projectRoot);
    },
  );

  server.tool(
    "task_manage",
    "Manage a task: force_status, skip, retry, or reset_evidence. Uses preview/confirm pattern.",
    {
      task_id: z.string().describe("Task id (e.g. 1.1.1)"),
      action: z.enum(["force_status", "skip", "retry", "reset_evidence"]).describe("Action to perform"),
      target_status: z.string().optional().describe("Required for force_status. Valid: pending, doing, done, failed, skipped"),
      confirm: z.boolean().default(false).describe("Set to true to apply; false (default) for preview"),
      project_root: projectRootSchema,
    },
    async (params) => {
      const ctx = resolveRequestContext(registry, stateManager, projectRoot, params.project_root);
       return handleTaskManage(params, ctx?.stateManager ?? stateManager, ctx?.evidenceManager ?? evidenceManager, ctx?.project_root ?? projectRoot);
    },
  );

  server.tool(
    "epic_manage",
    "Manage an epic: force_status, reset_tasks, or skip. Optional cascade to child tasks. Uses preview/confirm pattern.",
    {
      epic_id: z.string().describe("Epic id (e.g. 1.1)"),
      action: z.enum(["force_status", "reset_tasks", "skip"]).describe("Action to perform"),
      target_status: z.string().optional().describe("Required for force_status. Valid: pending, doing, done, failed, skipped"),
      cascade: z.boolean().default(false).describe("Also apply action to child tasks (force_status, skip)"),
      confirm: z.boolean().default(false).describe("Set to true to apply; false (default) for preview"),
      project_root: projectRootSchema,
    },
    async (params) => {
      const ctx = resolveRequestContext(registry, stateManager, projectRoot, params.project_root);
       return handleEpicManage(params, ctx?.stateManager ?? stateManager, ctx?.evidenceManager ?? evidenceManager, ctx?.project_root ?? projectRoot);
    },
  );

  server.tool(
    "phase_manage",
    "Manage a phase: force_status or skip. Skip always cascades to all child epics and tasks. Uses preview/confirm pattern.",
    {
      phase_id: z.string().describe("Phase id (e.g. 1 or 2)"),
      action: z.enum(["force_status", "skip"]).describe("Action to perform"),
      target_status: z.string().optional().describe("Required for force_status. Valid: pending, doing, done, failed, skipped"),
      confirm: z.boolean().default(false).describe("Set to true to apply; false (default) for preview"),
      project_root: projectRootSchema,
    },
    async (params) => {
      const ctx = resolveRequestContext(registry, stateManager, projectRoot, params.project_root);
       return handlePhaseManage(params, ctx?.stateManager ?? stateManager, ctx?.evidenceManager ?? evidenceManager, ctx?.project_root ?? projectRoot);
    },
  );

  server.registerTool(
    "cycle_diagnose",
    {
      description: "Run diagnostics on the current cycle — validation, stuck detection, evidence audit",
      inputSchema: z.object({ project_root: projectRootSchema }).default({}),
    },
    async (params) => {
      const ctx = resolveRequestContext(registry, stateManager, projectRoot, params?.project_root);
       return handleCycleDiagnose(ctx?.stateManager ?? stateManager, ctx?.evidenceManager ?? evidenceManager, ctx?.project_root ?? projectRoot, ctx?.config ?? config);
    },
  );
}
