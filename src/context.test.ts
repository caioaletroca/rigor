import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ProjectContextRegistry, resolveProjectRoot } from "./context.js";

describe("project context", () => {
  it("discovers the nearest git root from an absolute plan path", () => {
    const root = mkdtempSync(join(tmpdir(), "rigor-context-"));
    mkdirSync(join(root, ".git"));
    const nested = join(root, "docs", "plans");
    mkdirSync(nested, { recursive: true });
    const result = resolveProjectRoot({ plan_path: join(nested, "plan.md"), fallback_root: tmpdir() });
    expect(result.project_root).toBe(root);
    expect(result.source).toBe("plan");
    rmSync(root, { recursive: true, force: true });
  });

  it("reuses contexts by canonical root", () => {
    const registry = new ProjectContextRegistry();
    const first = registry.get({ project_root: process.cwd(), fallback_root: tmpdir() });
    const second = registry.get({ project_root: first.project_root, fallback_root: tmpdir() });
    expect(second).toBe(first);
  });

  it("rejects ambiguous relative plan paths", () => {
    expect(() => resolveProjectRoot({ plan_path: "plans/plan.md", fallback_root: tmpdir() })).toThrow(
      /Ambiguous plan_path.*absolute path.*project_root/,
    );
  });

  it("rejects an absolute plan outside an explicit project root", () => {
    const explicit = mkdtempSync(join(tmpdir(), "rigor-explicit-"));
    const planRoot = mkdtempSync(join(tmpdir(), "rigor-plan-"));
    mkdirSync(join(explicit, ".git"));
    mkdirSync(join(planRoot, ".git"));
    expect(() => resolveProjectRoot({
      project_root: explicit,
      plan_path: join(planRoot, "plan.md"),
      fallback_root: tmpdir(),
    })).toThrow(/must be inside project_root/);
    rmSync(explicit, { recursive: true, force: true });
    rmSync(planRoot, { recursive: true, force: true });
  });
});
