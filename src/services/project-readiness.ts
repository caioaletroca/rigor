import { getGate0CheckProvenance, loadConfig } from "../config/index.js";
import type { Gate0CheckProvenance, RigorConfig } from "../config/index.js";
import { resolveProjectRoot } from "../context.js";
import { evaluateGate0Readiness } from "../gates/index.js";
import type { Gate0Readiness } from "../gates/index.js";
import { inspectWorkspace, WorkspaceInspectionError } from "../workspace/index.js";

export interface ProjectReadinessParams {
  project_root?: string;
  plan_path?: string;
}

export interface ProjectReadinessEvaluation {
  project_root: string;
  root_source: "explicit" | "plan" | "fallback";
  fallback_warning?: string;
  config: RigorConfig;
  workspace: ReturnType<typeof inspectWorkspace> | null;
  workspace_policy: {
    require_worktree: boolean;
    require_feature_branch: boolean;
    base_branches: string[];
    failures: string[];
    inspection_failure?: string;
  };
  gate_0: Gate0Readiness & { provenance: Gate0CheckProvenance };
}

export function evaluateProjectReadiness(
  params: ProjectReadinessParams,
  fallbackRoot: string,
  config?: RigorConfig,
): ProjectReadinessEvaluation {
  const root = resolveProjectRoot({
    project_root: params.project_root,
    plan_path: params.plan_path,
    fallback_root: fallbackRoot,
  });
  return evaluateResolvedProjectReadiness(root, config);
}

export function evaluateResolvedProjectReadiness(
  root: { project_root: string; source: "explicit" | "plan" | "fallback"; warning?: string },
  config?: RigorConfig,
): ProjectReadinessEvaluation {
  const effectiveConfig = config ?? loadConfig(root.project_root);
  const gate0 = evaluateGate0Readiness(effectiveConfig);
  let workspace: ReturnType<typeof inspectWorkspace> | null = null;
  let inspectionFailure: string | undefined;

  try {
    workspace = inspectWorkspace(root.project_root);
  } catch (error) {
    inspectionFailure = error instanceof WorkspaceInspectionError ? error.message : String(error);
  }

  const failures: string[] = [];
  if (workspace) {
    if (effectiveConfig.workspace.require_worktree && !workspace.is_linked_worktree) {
      failures.push("A dedicated linked worktree is required.");
    }
    if (workspace.detached) failures.push("A non-detached branch is required.");
    if (workspace.branch !== null && effectiveConfig.workspace.require_feature_branch && effectiveConfig.workspace.base_branches.includes(workspace.branch)) {
      failures.push(`Branch '${workspace.branch}' is an integration branch, not an agent workspace.`);
    }
  }

  return {
    project_root: root.project_root,
    root_source: root.source,
    fallback_warning: root.warning,
    config: effectiveConfig,
    workspace,
    workspace_policy: {
      require_worktree: effectiveConfig.workspace.require_worktree,
      require_feature_branch: effectiveConfig.workspace.require_feature_branch,
      base_branches: effectiveConfig.workspace.base_branches,
      failures,
      inspection_failure: inspectionFailure,
    },
    gate_0: { ...gate0, provenance: getGate0CheckProvenance(effectiveConfig) },
  };
}

export function gate0ReadinessBlockMessage(taskId: string, readiness: ProjectReadinessEvaluation): string {
  const provenance = readiness.gate_0.provenance;
  const source = provenance.path ? `${provenance.category} (${provenance.path})` : provenance.category;
  const overrideAdvice = provenance.category === "domain_defaults"
    ? "Set a concrete gates.gate_0.checks list in the project config to override this domain check, or remove/resolve the domain check."
    : "Set a concrete gates.gate_0.checks list in the project config to replace this command.";
  const rootAdvice = readiness.root_source === "fallback"
    ? " This used the server fallback root; pass the active worktree's absolute project_root."
    : "";
  return `Task ${taskId} blocked: ${readiness.gate_0.detail} Gate 0 check source: ${source}. ${overrideAdvice}${rootAdvice}`;
}
