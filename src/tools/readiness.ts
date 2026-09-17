import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { evaluateProjectReadiness } from "../services/project-readiness.js";
import { projectRootSchema } from "./lifecycle.js";
import { responseResult } from "./response.js";

export interface ProjectReadinessParams {
  project_root?: string;
  plan_path?: string;
}

export function handleProjectReadiness(
  params: ProjectReadinessParams,
  fallbackRoot: string,
): CallToolResult {
  const evaluation = evaluateProjectReadiness(params, fallbackRoot);

  const readiness = {
    project_root: evaluation.project_root,
    root_source: evaluation.root_source,
    fallback_warning: evaluation.fallback_warning,
    workspace: evaluation.workspace,
    workspace_policy: evaluation.workspace_policy,
    gate_0: {
      ready: evaluation.gate_0.ready,
      detail: evaluation.gate_0.detail,
      unresolved_variables: evaluation.gate_0.unresolved_variables,
      empty_checks: evaluation.gate_0.empty_checks,
      provenance: evaluation.gate_0.provenance,
    },
  };
  const guidance = evaluation.root_source === "fallback"
    ? ["Fallback-root result is diagnostic only; lifecycle callers should pass the active worktree's absolute project_root."]
    : undefined;
  return responseResult(JSON.stringify(readiness), { guidance });
}

export function registerReadinessTool(server: McpServer, fallbackRoot: string): void {
  server.tool(
    "project_readiness",
    "Inspect effective project root, workspace policy, and Gate 0 readiness without mutating project state",
    {
      project_root: projectRootSchema,
      plan_path: z.string().optional().describe("Optional plan path used to derive a Git project root when project_root is omitted"),
    },
    async (params) => handleProjectReadiness(params, fallbackRoot),
  );
}
