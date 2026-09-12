import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectContextRegistry, resolveProjectRoot } from "./context.js";
import { createServer } from "./server.js";

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "rigor-context-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".rigor"));
  writeFileSync(join(root, ".rigor", "config.yaml"), "sync:\n  enabled: true\n");
  return root;
}

function phases() {
  return [{
    id: 1,
    status: "pending" as const,
    epics: [{
      id: "1.1",
      name: "Epic",
      status: "pending" as const,
      tasks: [{ id: "1.1.1", name: "Task", status: "pending" as const, gate_0: { passed: false } }],
      gate_8: { passed: false },
      gate_9: { passed: false },
    }],
  }];
}

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

  it("reuses context and sync manager for canonical root aliases", () => {
    const root = makeProject();
    const registry = new ProjectContextRegistry();
    const first = registry.get({ project_root: root, fallback_root: tmpdir() });
    const second = registry.get({ project_root: join(root, "."), fallback_root: tmpdir() });
    expect(second).toBe(first);
    expect(second.syncManager).toBe(first.syncManager);
    rmSync(root, { recursive: true, force: true });
  });

  it("creates isolated managers for different roots and wires lifecycle sync", () => {
    const firstRoot = makeProject();
    const secondRoot = makeProject();
    const registry = new ProjectContextRegistry();
    const first = registry.getByRoot(firstRoot);
    const second = registry.getByRoot(secondRoot);
    expect(second).not.toBe(first);
    expect(second.stateManager).not.toBe(first.stateManager);
    expect(second.syncManager).not.toBe(first.syncManager);
    first.stateManager.init("plan.md", phases());
    expect(first.syncManager?.getEventCount()).toBe(1);
    expect(second.syncManager?.getEventCount()).toBe(0);
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  });

  it("uses the default context sync manager for server tools", () => {
    const root = makeProject();
    const server = createServer(root);
    const context = server.registry.getByRoot(root);
    expect(server.stateManager).toBe(context.stateManager);
    expect(server.evidenceManager).toBe(context.evidenceManager);
    expect(server.syncManager).toBe(context.syncManager);
    rmSync(root, { recursive: true, force: true });
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
