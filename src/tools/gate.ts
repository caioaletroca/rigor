import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { projectRootSchema, resolveRequestContext } from "./lifecycle.js";
import type { StateManager } from "../state/index.js";
import type { ProjectContextRegistry } from "../context.js";
import {
  handleTaskComplete,
  handleTaskStart,
} from "../services/task-lifecycle.js";

export function registerGateTools(
  server: McpServer,
  stateManager: StateManager,
  projectRoot: string,
  registry?: ProjectContextRegistry,
): void {
  server.tool(
    "task_start",
    "Begin work on a task — validates entry criteria, transitions to doing",
    { task_id: z.string().describe("Task id (e.g. 1.1.1)"), owner_id: z.string().min(1).optional().describe("Advisory worker id recorded for coordination only"), project_root: projectRootSchema },
    async (params) => {
      const ctx = resolveRequestContext(registry, stateManager, projectRoot, params.project_root);
      return handleTaskStart(params, ctx?.stateManager ?? stateManager, ctx?.config ?? null, ctx?.project_root ?? projectRoot);
    },
  );

  server.tool(
    "task_complete",
    "Complete a task — runs Gate 0 exit checks (tests, coverage, lint), saves evidence",
    { task_id: z.string().describe("Task id (e.g. 1.1.1)"), project_root: projectRootSchema },
    async (params) => {
      const ctx = resolveRequestContext(registry, stateManager, projectRoot, params.project_root);
      return handleTaskComplete(params, ctx?.stateManager ?? stateManager, ctx?.config ?? null, ctx?.project_root ?? projectRoot);
    },
  );
}
