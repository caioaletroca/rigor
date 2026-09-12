import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHarnessSession, withHarnessSessions } from "../../testing/transport-harness.js";

function makeFixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `rigor-transport-${name}-`));
  execFileSync("git", ["init", "--quiet", root]);
  mkdirSync(join(root, ".rigor"));
  writeFileSync(join(root, ".rigor", "config.yaml"), "workspace:\n  allow_override: true\n");
  cpSync(
    join(import.meta.dirname, "..", "..", "plan", "__tests__", "fixtures", "sample-plan.md"),
    join(root, "plan.md"),
  );
  return root;
}

function text(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("cross-client transport harness", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("matches the README MCP tool inventory to the actual server tools/list response", async () => {
    const session = await createHarnessSession(process.cwd(), "opencode");
    try {
      const inventory = await session.client.listTools();
      const documentedSection = readFileSync(join(process.cwd(), "README.md"), "utf-8")
        .split("## MCP tools", 2)[1]
        .split("## Configuration", 1)[0];
      const documented = [...documentedSection.matchAll(/\| `([^`]+)` \|/g)]
        .map((match) => match[1])
        .sort();
      const registered = inventory.tools.map((tool) => tool.name).sort();

      expect(registered).toHaveLength(23);
      expect(documented).toEqual(registered);
    } finally {
      await session.close();
    }
  });

  it("runs concurrent client-style lifecycle, gate, and recovery flows independently", async () => {
    const projectA = makeFixture("a");
    const projectB = makeFixture("b");
    const projectC = makeFixture("c");
    roots.push(projectA, projectB, projectC);

    await withHarnessSessions([
      { projectRoot: projectA, clientStyle: "opencode" },
      { projectRoot: projectB, clientStyle: "claude" },
      { projectRoot: projectC, clientStyle: "hermes" },
    ], async (sessions) => {
      const initialized = await Promise.all(
        sessions.map((session) => session.call("cycle_init", { plan_path: "plan.md", allow_shared_workspace: true })),
      );
      expect(initialized.every((result) => !result.isError)).toBe(true);

      const statuses = await Promise.all(
        sessions.map((session) => session.call("cycle_status")),
      );
      expect(text(statuses[0])).toContain(projectA);
      expect(text(statuses[1])).toContain(projectB);
      expect(text(statuses[2])).toContain(projectC);
      expect(text(statuses[0])).not.toContain(projectB);

      const gateStarts = await Promise.all(
        sessions.map((session) => session.call("task_start", { task_id: "1.1.2" })),
      );
      expect(gateStarts).toHaveLength(3);
      expect(gateStarts.every((result) => text(result).length > 0)).toBe(true);

      const recovered = await Promise.all(
        sessions.map((session) => session.call("task_manage", {
          task_id: "1.1.2",
          action: "force_status",
          target_status: "skipped",
          confirm: true,
        })),
      );
      expect(recovered.every((result) => !result.isError)).toBe(true);

      const finalStatuses = await Promise.all(
        sessions.map((session) => session.call("cycle_status")),
      );
      expect(finalStatuses.every((result) => text(result).includes("Active Task: none"))).toBe(true);
    });
  });

  it("rejects relative project_root at the MCP boundary while preserving omitted-root fallback", async () => {
    const project = makeFixture("project-root-schema");
    roots.push(project);

    await withHarnessSessions([{ projectRoot: project, clientStyle: "opencode" }], async ([session]) => {
      const initialized = await session.call("cycle_init", { plan_path: "plan.md", allow_shared_workspace: true });
      expect(initialized.isError).toBeUndefined();

      const invalid = await session.call("cycle_status", { project_root: "relative-project" });
      expect(invalid.isError).toBe(true);
      expect(text(invalid)).toContain("project_root must be an absolute path");

      const status = await session.call("cycle_status");
      expect(status.isError).toBeUndefined();
      expect(text(status)).toContain(project);
    });
  });

  it("renews leases per project root and rejects stale attempts over the transport", async () => {
    const projectA = makeFixture("renew-a");
    const projectB = makeFixture("renew-b");
    roots.push(projectA, projectB);

    await withHarnessSessions([
      { projectRoot: projectA, clientStyle: "opencode" },
      { projectRoot: projectB, clientStyle: "claude" },
    ], async (sessions) => {
      await Promise.all(sessions.map((session) => session.call("cycle_init", { plan_path: "plan.md", allow_shared_workspace: true })));
      await Promise.all(sessions.map((session, index) => session.call("task_start", { task_id: "1.1.2", owner_id: `owner-${index}` })));

      const tools = await sessions[0].client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("task_renew");

      const leaseA = JSON.parse(readFileSync(join(projectA, ".rigor", "state.json"), "utf-8"))
        .phases[0].epics[0].tasks.find((task: { id: string }) => task.id === "1.1.2").lease;

      const renewed = await sessions[0].call("task_renew", {
        task_id: "1.1.2",
        owner_id: leaseA.owner_id,
        attempt_id: leaseA.attempt_id,
        project_root: projectA,
      });
      expect(renewed.isError).toBeUndefined();
      expect(text(renewed)).toContain("lease renewed");

      const stale = await sessions[1].call("task_renew", {
        task_id: "1.1.2",
        owner_id: leaseA.owner_id,
        attempt_id: leaseA.attempt_id,
        project_root: projectB,
      });
      expect(stale.isError).toBe(true);
      expect(text(stale)).toContain("not renewed");
    });
  });

  it("keeps representative multi-project operations within release budgets", async () => {
    const samples: number[] = [];
    const sampleCount = 5;

    for (let sample = 0; sample < sampleCount; sample += 1) {
      const fixtures = [makeFixture(`budget-${sample}-a`), makeFixture(`budget-${sample}-b`), makeFixture(`budget-${sample}-c`)];
      roots.push(...fixtures);
      const started = performance.now();
      await withHarnessSessions(
        fixtures.map((projectRoot, index) => ({
          projectRoot,
          clientStyle: (["opencode", "claude", "hermes"] as const)[index],
        })),
      async (sessions) => {
        const initialized = await Promise.all(sessions.map((session) => session.call("cycle_init", { plan_path: "plan.md", allow_shared_workspace: true })));
        expect(initialized.every((result) => !result.isError)).toBe(true);
        const statuses = await Promise.all(sessions.map((session) => session.call("cycle_status")));
        const statusText = statuses.map(text);
        for (let index = 0; index < statusText.length; index += 1) {
          expect(statusText[index]).toContain(fixtures[index]);
          for (let other = 0; other < fixtures.length; other += 1) {
            if (other !== index) expect(statusText[index]).not.toContain(fixtures[other]);
          }
        }
        const recovered = await Promise.all(sessions.map((session) => session.call("task_manage", {
          task_id: "1.1.1",
          action: "force_status",
          target_status: "skipped",
          confirm: true,
        })));
        expect(recovered.every((result) => !result.isError)).toBe(true);
        },
      );
      samples.push(performance.now() - started);
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    expect(p95).toBeLessThan(5000);
  });
});
