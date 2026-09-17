import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../../server.js";
import { handleCycleInit, handleCycleStatus } from "../cycle.js";
import { handleTaskManage, handleCycleDiagnose } from "../../services/recovery-lifecycle.js";

interface TextContent {
  type: "text";
  text: string;
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as TextContent).text;
}

function makeProject(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `rigor-${name}-`));
  execFileSync("git", ["init", "--quiet", root]);
  mkdirSync(join(root, ".rigor"));
  writeFileSync(
    join(root, ".rigor", "config.yaml"),
    "gates:\n  gate_0:\n    checks:\n      - name: runtime\n        command: \"node --version\"\nworkspace:\n  allow_override: true\n  require_worktree: false\n  require_feature_branch: false\n",
  );
  cpSync(join(import.meta.dirname, "..", "..", "plan", "__tests__", "fixtures", "sample-plan.md"), join(root, "plan.md"));
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  return root;
}

describe("multi-project server isolation", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("switches projects through registered cycle tools in one server session", async () => {
    const projectA = makeProject("switch-a");
    const projectB = makeProject("switch-b");
    roots.push(projectA, projectB);

    const serverContext = createServer(projectA);
    const tools = (serverContext.server as unknown as { _registeredTools: Record<string, { handler: (params?: unknown) => Promise<unknown> }> })._registeredTools;
    const init = (params: unknown) => tools.cycle_init.handler(params);
    const reload = (params: unknown) => tools.cycle_reload.handler(params);
    const status = (params: unknown) => tools.cycle_status.handler(params);
    const diagnose = (params: unknown) => tools.cycle_diagnose.handler(params);

    const first = await init({ plan_path: "plan.md", allow_shared_workspace: true });
    const second = await init({ plan_path: "plan.md", project_root: projectB, allow_shared_workspace: true });
    const firstSummary = JSON.parse(text(first as { content: Array<{ type: string; text?: string }> }));
    const secondSummary = JSON.parse(text(second as { content: Array<{ type: string; text?: string }> }));

    expect(firstSummary.project_root).toBe(projectA);
    expect(secondSummary.project_root).toBe(projectB);
    expect(firstSummary.cycle_id).toBeDefined();
    expect(secondSummary.cycle_id).toBeDefined();

    const reloaded = await reload({ project_root: projectB, plan_path: "plan.md" });
    expect((reloaded as { isError?: boolean }).isError).toBeUndefined();

    const statusB = await status({ project_root: projectB });
    expect(text(statusB as { content: Array<{ type: string; text?: string }> })).toContain(projectB);

    const statusA = await status({ project_root: projectA });
    expect(text(statusA as { content: Array<{ type: string; text?: string }> })).toContain(projectA);

    const diagnosedB = await diagnose({ project_root: projectB });
    expect(text(diagnosedB as { content: Array<{ type: string; text?: string }> })).not.toContain("No active cycle");
  });

  it("uses an explicit ready worktree when the fallback root is unready", async () => {
    const serverRoot = makeProject("unready-server-root");
    const worktree = makeProject("ready-worktree");
    roots.push(serverRoot, worktree);
    writeFileSync(
      join(serverRoot, ".rigor", "config.yaml"),
      "gates:\n  gate_0:\n    checks:\n      - name: tests\n        command: \"${lang.test_command}\"\nworkspace:\n  allow_override: true\n",
    );

    const serverContext = createServer(serverRoot);
    const tools = (serverContext.server as unknown as { _registeredTools: Record<string, { handler: (params?: unknown) => Promise<unknown> }> })._registeredTools;

    const init = await tools.cycle_init.handler({ plan_path: "plan.md", project_root: worktree, allow_shared_workspace: true });
    expect((init as { isError?: boolean }).isError).toBeUndefined();

    const start = await tools.task_start.handler({ task_id: "1.1.2", owner_id: "owner", project_root: worktree });
    expect((start as { isError?: boolean }).isError).toBeUndefined();
  });

  it("routes registered lifecycle tools to a non-default project after init", async () => {
    const serverRoot = makeProject("server-root");
    const worktree = makeProject("worktree");
    roots.push(serverRoot, worktree);

    const serverContext = createServer(serverRoot);
    const tools = (serverContext.server as unknown as { _registeredTools: Record<string, { handler: (params?: unknown) => Promise<unknown> }> })._registeredTools;

    await tools.cycle_init.handler({ plan_path: "plan.md", project_root: worktree, allow_shared_workspace: true });

    const status = await tools.cycle_status.handler({ project_root: worktree });
    const statusText = text(status as { content: Array<{ type: string; text?: string }> });
    expect(statusText).not.toContain("No active cycle");
    expect(statusText).toContain(worktree);

    const diagnosed = await tools.cycle_diagnose.handler({ project_root: worktree });
    expect(text(diagnosed as { content: Array<{ type: string; text?: string }> })).not.toContain("No active cycle");

    const managed = await tools.task_manage.handler({
      task_id: "1.1.1",
      action: "force_status",
      target_status: "done",
      confirm: true,
      project_root: worktree,
    });
    expect((managed as { isError?: boolean }).isError).toBeUndefined();
    expect(serverContext.registry.getByRoot(worktree).stateManager.getTask("1.1.1").status).toBe("done");

    const review = await tools.review_start.handler({ epic_id: "1.1", project_root: worktree });
    expect(text(review as { content: Array<{ type: string; text?: string }> })).not.toContain("No active cycle");

    const serverStatus = await tools.cycle_status.handler({ project_root: serverRoot });
    expect(text(serverStatus as { content: Array<{ type: string; text?: string }> })).toContain("No active cycle");
  });

  it("supports legacy fallback calls and rejects relative project_root values", async () => {
    const project = makeProject("compatibility");
    roots.push(project);
    const serverContext = createServer(project);
    const tools = (serverContext.server as unknown as { _registeredTools: Record<string, { handler: (params?: unknown) => Promise<unknown> }> })._registeredTools;

    const legacy = await tools.cycle_init.handler({ plan_path: "plan.md", allow_shared_workspace: true });
    const summary = JSON.parse(text(legacy as { content: Array<{ type: string; text?: string }> }));
    expect(summary.project_root).toBe(project);
    expect(summary.cycle_id).toBeDefined();

    const invalid = await tools.cycle_init.handler({ plan_path: "missing/plan.md", project_root: project });
    expect((invalid as { isError?: boolean }).isError).toBe(true);

    await expect(tools.cycle_reload.handler({ plan_path: "plan.md", project_root: "relative-project" })).rejects.toThrow(/Invalid project_root/);
  });

  it("isolates concurrent cycle, task, gate, evidence, and recovery operations", async () => {
    const projectA = makeProject("project-a");
    const projectB = makeProject("project-b");
    roots.push(projectA, projectB);

    const serverContext = createServer(projectA);
    const registry = serverContext.registry;
    const contextA = registry.getByRoot(projectA);
    const contextB = registry.getByRoot(projectB);

    await Promise.all([
      Promise.resolve(handleCycleInit({ plan_path: join(projectA, "plan.md"), allow_shared_workspace: true }, contextA.stateManager, projectA, registry)),
      Promise.resolve(handleCycleInit({ plan_path: join(projectB, "plan.md"), allow_shared_workspace: true }, contextB.stateManager, projectB, registry)),
    ]);

    const statuses = await Promise.all([
      Promise.resolve(handleCycleStatus(contextA.stateManager, contextA.evidenceManager, projectA)),
      Promise.resolve(handleCycleStatus(contextB.stateManager, contextB.evidenceManager, projectB)),
    ]);
    expect(text(statuses[0])).toContain("project-a");
    expect(text(statuses[0])).not.toContain("project-b");
    expect(text(statuses[1])).toContain("project-b");
    expect(text(statuses[1])).not.toContain("project-a");

    await Promise.all([
      Promise.resolve(handleTaskManage({ task_id: "1.1.1", action: "force_status", target_status: "done", confirm: true }, contextA.stateManager, contextA.evidenceManager, projectA)),
      Promise.resolve(handleTaskManage({ task_id: "1.1.1", action: "force_status", target_status: "skipped", confirm: true }, contextB.stateManager, contextB.evidenceManager, projectB)),
      Promise.resolve(handleCycleDiagnose(contextA.stateManager, contextA.evidenceManager, projectA)),
      Promise.resolve(handleCycleDiagnose(contextB.stateManager, contextB.evidenceManager, projectB)),
    ]);

    expect(contextA.stateManager.getTask("1.1.1").status).toBe("done");
    expect(contextB.stateManager.getTask("1.1.1").status).toBe("skipped");
    expect(existsSync(join(projectA, ".rigor", "state.json"))).toBe(true);
    expect(existsSync(join(projectB, ".rigor", "state.json"))).toBe(true);
    expect(readFileSync(join(projectA, ".rigor", "state.json"), "utf8")).toContain("project-a");
    expect(readFileSync(join(projectA, ".rigor", "state.json"), "utf8")).not.toContain("project-b");
    expect(readFileSync(join(projectB, ".rigor", "state.json"), "utf8")).toContain("project-b");
    expect(readFileSync(join(projectB, ".rigor", "state.json"), "utf8")).not.toContain("project-a");
  });
});
