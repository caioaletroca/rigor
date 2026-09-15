import { describe, expect, it } from "vitest";
import { projectRootSchema, resolveRequestContext, responseResult } from "../lifecycle.js";
import type { RequestContext } from "../../context.js";
import type { StateManager } from "../../state/index.js";

const projectRoot = process.platform === "win32" ? "C:/workspace/project" : "/workspace/project";

function context(): RequestContext {
  return {
    project_root: projectRoot,
    stateManager: {} as StateManager,
    evidenceManager: {} as RequestContext["evidenceManager"],
    config: {} as RequestContext["config"],
  };
}

describe("lifecycle adapter", () => {
  it("uses the shared optional absolute project-root schema", () => {
    expect(projectRootSchema.parse(undefined)).toBeUndefined();
    expect(projectRootSchema.parse(projectRoot)).toBe(projectRoot);
    expect(() => projectRootSchema.parse("relative-project")).toThrow(
      "project_root must be an absolute path",
    );
  });

  it("resolves an explicit request root through the registry", () => {
    const resolved = context();
    const registry = { getByRoot: (root: string) => {
      expect(root).toBe(projectRoot);
      return resolved;
    } };

    const fallbackRoot = process.platform === "win32" ? "C:/fallback" : "/fallback";

    expect(resolveRequestContext(registry as never, {} as StateManager, fallbackRoot, projectRoot)).toBe(resolved);
  });

  it("exposes the standard structured response helper", () => {
    const result = responseResult("Completed");

    expect(result.structuredContent).toMatchObject({ ok: true, message: "Completed" });
  });
});
