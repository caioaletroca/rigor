import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getGate0CheckProvenance, loadConfig } from "../config/index.js";
import { resolveProjectRoot } from "../context.js";
import { evaluateGate0Readiness } from "../gates/gate0.js";
import { inspectWorkspace, WorkspaceInspectionError } from "../workspace/index.js";
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
  const root = resolveProjectRoot({
    project_root: params.project_root,
    plan_path: params.plan_path,
    fallback_root: fallbackRoot,
  });
  const config = loadConfig(root.project_root);
  const gate0 = evaluateGate0Readiness(config);
  let workspace: ReturnType<typeof inspectWorkspace> | undefined;
  let workspaceFailure: string | undefined;

  try {
    workspace = inspectWorkspace(root.project_root);
  } catch (error) {
    workspaceFailure = error instanceof WorkspaceInspectionError ? error.message : String(error);
  }

  const policyFailures: string[] = [];
  if (workspace) {
    if (config.workspace.require_worktree && !workspace.is_linked_worktree) {
      policyFailures.push("A dedicated linked worktree is required.");
    }
    if (workspace.detached) policyFailures.push("A non-detached branch is required.");
    if (workspace.branch !== null && config.workspace.require_feature_branch && config.workspace.base_branches.includes(workspace.branch)) {
      policyFailures.push(`Branch '${workspace.branch}' is an integration branch, not an agent workspace.`);
    }
  }

  const readiness = {
    project_root: root.project_root,
    root_source: root.source,
    fallback_warning: root.warning,
    workspace: workspace ?? null,
    workspace_policy: {
      require_worktree: config.workspace.require_worktree,
      require_feature_branch: config.workspace.require_feature_branch,
      base_branches: config.workspace.base_branches,
      failures: policyFailures,
      inspection_failure: workspaceFailure,
    },
    gate_0: {
      ready: gate0.ready,
      detail: gate0.detail,
      unresolved_variables: gate0.unresolved_variables,
      empty_checks: gate0.empty_checks,
      provenance: getGate0CheckProvenance(config),
    },
  };
  const guidance = root.source === "fallback"
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
