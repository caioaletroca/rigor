import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StateManager } from "../state/index.js";
import type { EvidenceManager } from "../evidence/index.js";
import { ArchiveManager } from "../archive/manager.js";
import type { ProjectContextRegistry } from "../context.js";
import { projectRootSchema, resolveRequestContext } from "./lifecycle.js";
import {
  handleAcceptStart,
  handleAcceptSubmit,
  handlePhaseAdvance,
  handleReviewStart,
  handleReviewSubmit,
} from "../services/review-lifecycle.js";

export function registerReviewTools(server: McpServer, stateManager: StateManager, evidenceManager: EvidenceManager, projectRoot: string, registry?: ProjectContextRegistry): void {
  const archiveManager = new ArchiveManager(projectRoot);
  server.tool("review_start", "Start code review for an epic — verifies all tasks are done and passed Gate 0", { epic_id: z.string().describe("Epic id (e.g. 1.1)"), project_root: projectRootSchema }, async (params) => {
    const ctx = resolveRequestContext(registry, stateManager, projectRoot, params.project_root);
    return handleReviewStart(params, ctx?.stateManager ?? stateManager, ctx?.config ?? null, ctx?.project_root ?? projectRoot);
  });
  server.tool("review_submit", "Submit review findings for an epic — runs Gate 8 exit checks", { epic_id: z.string().describe("Epic id (e.g. 1.1)"), submissions: z.string().describe("JSON array of ReviewFindings objects"), project_root: projectRootSchema }, async (params) => {
    const ctx = resolveRequestContext(registry, stateManager, projectRoot, params.project_root);
    return handleReviewSubmit(params, ctx?.stateManager ?? stateManager, ctx?.evidenceManager ?? evidenceManager, ctx?.config ?? null, ctx?.project_root ?? projectRoot);
  });
  server.tool("accept_start", "Start acceptance for an epic — verifies Gate 8 passed", { epic_id: z.string().describe("Epic id (e.g. 1.1)"), project_root: projectRootSchema }, async (params) => {
    return handleAcceptStart(params, resolveRequestContext(registry, stateManager, projectRoot, params.project_root)?.stateManager ?? stateManager);
  });
  server.tool("accept_submit", "Submit acceptance criteria for an epic — runs Gate 9 exit checks", { epic_id: z.string().describe("Epic id (e.g. 1.1)"), criteria: z.string().describe("JSON array of AcceptanceCriterion objects"), user_approved: z.boolean().default(false).describe("Whether the user has approved the epic"), project_root: projectRootSchema }, async (params) => {
    const ctx = resolveRequestContext(registry, stateManager, projectRoot, params.project_root);
    return handleAcceptSubmit(params, ctx?.stateManager ?? stateManager, ctx?.evidenceManager ?? evidenceManager, ctx?.config ?? null, ctx?.project_root ?? projectRoot);
  });
  server.registerTool("phase_advance", { description: "Advance to the next phase — verifies all epics in current phase are done", inputSchema: z.object({ project_root: projectRootSchema }).default({}) }, async (params) => {
    const ctx = resolveRequestContext(registry, stateManager, projectRoot, params?.project_root);
    return handlePhaseAdvance(ctx?.stateManager ?? stateManager, ctx?.evidenceManager ?? evidenceManager, ctx ? new ArchiveManager(ctx.project_root) : archiveManager, ctx?.project_root ?? projectRoot);
  });
}
