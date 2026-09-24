import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  NON_LIFECYCLE_TOOLS,
  REGISTERED_TOOL_NAMES,
  RIGOR_SCHEMA_VERSION,
  ROOT_AWARE_LIFECYCLE_TOOLS,
} from "../server-info.js";
import { SyncManager } from "../../sync/manager.js";
import { createHarnessRegistry, createHarnessSession, withHarnessSessions } from "../../testing/transport-harness.js";

function makeFixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `rigor-transport-${name}-`));
  execFileSync("git", ["init", "--quiet", root]);
  mkdirSync(join(root, ".rigor"));
  writeFileSync(join(root, ".rigor", "config.yaml"), "workspace:\n  allow_override: true\n  require_worktree: false\n  require_feature_branch: false\ngates:\n  gate_0:\n    allow_empty: true\n");
  cpSync(
    join(import.meta.dirname, "..", "..", "plan", "__tests__", "fixtures", "sample-plan.md"),
    join(root, "plan.md"),
  );
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
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

      expect(registered).toEqual(REGISTERED_TOOL_NAMES);
      expect(documented).toEqual(registered);
    } finally {
      await session.close();
    }
  });

  it("reports and advertises the live root-aware lifecycle contract", async () => {
    const session = await createHarnessSession(process.cwd(), "opencode");
    try {
      const inventory = await session.client.listTools();
      expect(inventory.tools.map((tool) => tool.name).sort()).toEqual(REGISTERED_TOOL_NAMES);

      const result = await session.call("rigor_status", { client_schema_version: RIGOR_SCHEMA_VERSION });
      const status = JSON.parse(text(result));
      expect(status).toMatchObject({
        schema_version: RIGOR_SCHEMA_VERSION,
        fallback_root: process.cwd(),
        reconnect_required: false,
      });
      expect(status.root_aware_lifecycle_tools).toEqual([...ROOT_AWARE_LIFECYCLE_TOOLS].sort());

      const toolsByName = new Map(inventory.tools.map((tool) => [tool.name, tool]));
      const lifecycleTools = inventory.tools
        .map((tool) => tool.name)
        .filter((name) => !NON_LIFECYCLE_TOOLS.includes(name as typeof NON_LIFECYCLE_TOOLS[number]))
        .sort();
      expect(status.root_aware_lifecycle_tools).toEqual(lifecycleTools);

      for (const name of NON_LIFECYCLE_TOOLS) {
        expect(toolsByName.get(name)?.inputSchema.properties ?? {}, name).not.toHaveProperty("project_root");
      }
 
      for (const name of status.root_aware_lifecycle_tools) {
        const schema = toolsByName.get(name)?.inputSchema;
        expect(schema, name).toMatchObject({
          type: "object",
          properties: {
            project_root: {
              type: "string",
              description: expect.stringMatching(/absolute.*root/i),
            },
          },
        });
        expect(schema?.required ?? [], name).not.toContain("project_root");
      }
    } finally {
      await session.close();
    }
  });

  it("serves project readiness over live MCP without creating lifecycle artifacts", async () => {
    const project = makeFixture("readiness");
    roots.push(project);
    const before = readdirSync(join(project, ".rigor")).sort();
    const session = await createHarnessSession(process.cwd(), "opencode");

    try {
      const result = await session.call("project_readiness", { project_root: "relative-root" });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("project_root must be an absolute path");

      const explicitResult = await session.call("project_readiness", { project_root: project });
      const readiness = JSON.parse(text(explicitResult));
      expect(explicitResult.isError).toBeUndefined();
      expect(readiness).toMatchObject({
        project_root: project,
        root_source: "explicit",
        gate_0: { ready: true, provenance: { category: "core_defaults" } },
      });
      expect(readdirSync(join(project, ".rigor")).sort()).toEqual(before);
    } finally {
      await session.close();
    }
  });

  it("rejects relative project roots for cycle and sync tools", async () => {
    const project = makeFixture("relative-root");
    roots.push(project);
    const session = await createHarnessSession(project, "opencode");

    try {
      const requests: Array<[string, Record<string, unknown>]> = [
        ["cycle_init", { plan_path: "plan.md", project_root: "relative-root" }],
        ["cycle_reload", { project_root: "relative-root" }],
        ["cycle_status", { project_root: "relative-root" }],
        ["sync_status", { project_root: "relative-root" }],
        ["sync_retry", { provider: "test", project_root: "relative-root" }],
        ["sync_replay", { provider: "test", project_root: "relative-root" }],
        ["sync_enable", { provider: "test", project_root: "relative-root" }],
      ];

      for (const [tool, params] of requests) {
        const result = await session.call(tool, params);
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("project_root must be an absolute path");
      }
    } finally {
      await session.close();
    }
  });

  it("routes sync MCP tools to only the explicit project's manager, journal, and provider", async () => {
    const projectA = makeFixture("sync-a");
    const projectB = makeFixture("sync-b");
    roots.push(projectA, projectB);
    const providerA = vi.fn(async () => {});
    let failProviderB = true;
    const providerB = vi.fn(async () => {
      if (failProviderB) throw new Error("retry target");
    });

    const registry = createHarnessRegistry(projectA).registry;
    const managerA = registry.getByRoot(projectA).syncManager;
    const managerB = registry.getByRoot(projectB).syncManager;
    expect(managerA).toBeUndefined();
    expect(managerB).toBeUndefined();

    const contexts = new Map([
      [projectA, { syncManager: new SyncManager(projectA, [{ name: "provider-a", sync: providerA }], "provider-a", 1) }],
      [projectB, { syncManager: new SyncManager(projectB, [{ name: "provider-b", sync: providerB }], "provider-b", 1) }],
    ]);
    vi.spyOn(registry, "getByRoot").mockImplementation((root) => contexts.get(root) as ReturnType<typeof registry.getByRoot>);

    const session = await createHarnessSession(projectA, "opencode", { registry });
    try {
      const target = contexts.get(projectB)!.syncManager!;
      const other = contexts.get(projectA)!.syncManager!;
      const event = {
        event_id: crypto.randomUUID(),
        type: "task_started" as const,
        entity_type: "task" as const,
        entity_id: "1.1.1",
        cycle_id: "sync-routing",
        timestamp: new Date().toISOString(),
      };
      await target.dispatch(event);
      await other.dispatch({ ...event, event_id: crypto.randomUUID() });
      failProviderB = false;
      expect(providerA).toHaveBeenCalledTimes(1);
      expect(providerB).toHaveBeenCalledTimes(1);

      const status = await session.call("sync_status", { project_root: projectB });
      expect(text(status)).toContain("provider-b");
      expect(text(status)).toContain(join(projectB, ".rigor", "sync", "events.jsonl"));
      expect(text(status)).not.toContain("provider-a");
      expect(text(status)).not.toContain(projectA);

      const retry = await session.call("sync_retry", { project_root: projectB, provider: "provider-b", count: 1 });
      expect(text(retry)).toContain("1 succeeded");
      expect(providerB).toHaveBeenCalledTimes(2);
      expect(providerA).toHaveBeenCalledTimes(1);

      const replay = await session.call("sync_replay", { project_root: projectB, provider: "provider-b" });
      expect(text(replay)).toContain("1 succeeded");
      expect(providerB).toHaveBeenCalledTimes(3);
      expect(providerA).toHaveBeenCalledTimes(1);

      const failing = vi.fn(async () => { throw new Error("trip circuit"); });
      const disabledTarget = new SyncManager(projectB, [{ name: "disabled-b", sync: failing }], undefined, 1);
      contexts.set(projectB, { syncManager: disabledTarget });
      await disabledTarget.dispatch(event);
      expect(disabledTarget.isProviderDisabled("disabled-b")).toBe(true);

      const enabled = await session.call("sync_enable", { project_root: projectB, provider: "disabled-b" });
      expect(text(enabled)).toContain("re-enabled");
      expect(disabledTarget.isProviderDisabled("disabled-b")).toBe(false);
      expect(other.isProviderDisabled("provider-a")).toBe(false);
      expect(registry.getByRoot).toHaveBeenCalledWith(projectB);
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
        sessions.map((session) => session.call("cycle_status", {})),
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
        sessions.map((session) => session.call("cycle_status", {})),
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

      const status = await session.call("cycle_status", {});
      expect(status.isError).toBeUndefined();
      expect(text(status)).toContain(project);
    });
  });

  it("discards legacy lease data before transport lifecycle operations", async () => {
    const project = makeFixture("legacy-lease");
    roots.push(project);

    await withHarnessSessions([{ projectRoot: project, clientStyle: "opencode" }], async ([session]) => {
      await session.call("cycle_init", { plan_path: "plan.md", allow_shared_workspace: true });
      const statePath = join(project, ".rigor", "state.json");
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      state.phases[0].epics[0].tasks.find((task: { id: string }) => task.id === "1.1.2").lease = {
        owner_id: "owner-a",
        attempt_id: "attempt-a",
        lease_expires_at: "not-a-timestamp",
        takeover_history: [{ owner_id: "owner-z", attempt_id: "attempt-z", lease_expires_at: "2020-01-01T00:00:00.000Z", taken_over_at: "2020-01-01T00:00:00.000Z" }],
      };
      writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

      const started = await session.call("task_start", { task_id: "1.1.2", owner_id: "owner-b" });
      expect(started.isError).toBeUndefined();

      const migrated = JSON.parse(readFileSync(statePath, "utf-8"));
      const task = migrated.phases[0].epics[0].tasks.find((candidate: { id: string }) => candidate.id === "1.1.2");
      expect(task).not.toHaveProperty("lease");
      expect(task.worker.owner_id).toBe("owner-b");
    });
  });

  it("warns and replaces the advisory worker for competing starts in one project root", async () => {
    const project = makeFixture("same-root-worker");
    roots.push(project);

    await withHarnessSessions([{ projectRoot: project, clientStyle: "opencode" }], async ([session]) => {
      await session.call("cycle_init", { plan_path: "plan.md", allow_shared_workspace: true });
      await session.call("task_start", { task_id: "1.1.2", owner_id: "owner-a" });

      const replacement = await session.call("task_start", { task_id: "1.1.2", owner_id: "owner-b" });

      expect(replacement.isError).toBeUndefined();
      const advisoryWarning = text(replacement)
        .split("\n")
        .find((line) => line.startsWith("Warning: task 1.1.2 was started by"));
      expect(advisoryWarning).toMatch(
        /^Warning: task 1\.1\.2 was started by "owner-a" at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z in this workspace\. Coordinate file ownership or use separate worktrees\.$/,
      );
      const state = JSON.parse(readFileSync(join(project, ".rigor", "state.json"), "utf-8"));
      expect(state.phases[0].epics[0].tasks.find((task: { id: string }) => task.id === "1.1.2").worker.owner_id).toBe("owner-b");
    });
  });

  it("records advisory workers per project root without exposing renewal", async () => {
    const projectA = makeFixture("worker-a");
    const projectB = makeFixture("worker-b");
    roots.push(projectA, projectB);

    await withHarnessSessions([
      { projectRoot: projectA, clientStyle: "opencode" },
      { projectRoot: projectB, clientStyle: "claude" },
    ], async (sessions) => {
      await Promise.all(sessions.map((session) => session.call("cycle_init", { plan_path: "plan.md", allow_shared_workspace: true })));
      await Promise.all(sessions.map((session, index) => session.call("task_start", { task_id: "1.1.2", owner_id: `owner-${index}` })));

      const tools = await sessions[0].client.listTools();
      expect(tools.tools.map((tool) => tool.name)).not.toContain("task_renew");

      const workerFor = (root: string) =>
        JSON.parse(readFileSync(join(root, ".rigor", "state.json"), "utf-8"))
          .phases[0].epics[0].tasks.find((task: { id: string }) => task.id === "1.1.2").worker;

      expect(workerFor(projectA).owner_id).toBe("owner-0");
      expect(workerFor(projectB).owner_id).toBe("owner-1");
      expect(workerFor(projectA)).not.toHaveProperty("lease_expires_at");
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
        const statuses = await Promise.all(sessions.map((session) => session.call("cycle_status", {})));
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
  }, 30000);
});
