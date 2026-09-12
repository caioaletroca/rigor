import { isAbsolute } from "node:path";
import { z } from "zod";
import type { StateManager } from "../state/index.js";
import type { ProjectContextRegistry, RequestContext } from "../context.js";

export { responseResult } from "./response.js";

export const projectRootSchema = z
  .string()
  .refine(isAbsolute, "project_root must be an absolute path")
  .optional()
  .describe("Absolute Git repository root; defaults to the server --project-root");

export function resolveRequestContext(
  registry: ProjectContextRegistry | undefined,
  stateManager: StateManager,
  projectRoot: string,
  requestRoot?: string,
): RequestContext | undefined {
  return registry?.getByRoot(requestRoot ?? stateManager.load()?.project_root ?? projectRoot);
}
