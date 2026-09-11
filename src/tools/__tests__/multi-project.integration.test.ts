import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../../server.js";
import { handleCycleInit, handleCycleStatus } from "../cycle.js";
import { handleTaskManage, handleCycleDiagnose } from "../recovery.js";

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
  cpSync(join(import.meta.dirname, "..", "..", "plan", "__tests__", "fixtures", "sample-plan.md"), join(root, "plan.md"));
  return root;
}

describe("multi-project server isolation", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
      Promise.resolve(handleCycleInit({ plan_path: join(projectA, "plan.md") }, contextA.stateManager, projectA, registry)),
      Promise.resolve(handleCycleInit({ plan_path: join(projectB, "plan.md") }, contextB.stateManager, projectB, registry)),
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
