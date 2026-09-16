import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "../state/index.js";
import type { PhaseState } from "../state/index.js";
import { getGlobalConfigPath } from "../config/index.js";
import { handleTaskStart } from "./task-lifecycle.js";

function makePhases(): PhaseState[] {
  return [{
    id: 1,
    status: "pending",
    epics: [{
      id: "1.1",
      name: "Epic",
      status: "pending",
      tasks: [{ id: "1.1.1", name: "Task", status: "pending", gate_0: { passed: false } }],
      gate_8: { passed: false },
      gate_9: { passed: false },
    }],
  }];
}

function writeConfig(root: string, config: string): void {
  mkdirSync(join(root, ".rigor"), { recursive: true });
  writeFileSync(join(root, ".rigor", "config.yaml"), config, "utf-8");
}

describe("task_start Gate 0 readiness integration", () => {
  it.each([
    ["unresolved", "- name: tests\n        command: '${lang.test_command}'"],
    ["mixed", "- name: runnable\n        command: \"node --version\"\n      - name: unresolved\n        command: '${lang.lint_command}'"],
  ])("blocks %s configured commands before custom gates, leases, and evidence", async (_name, checks) => {
    const root = mkdtempSync(join(tmpdir(), "rigor-task-start-readiness-"));
    const marker = join(root, "custom-ran");
    const stateManager = new StateManager(root);
    stateManager.init("plan.md", makePhases());
    writeConfig(root, `
gates:
  gate_0:
    checks:
      ${checks}
  gate_1:
    enabled: false
  custom_gates:
    - name: side-effect
      command: 'echo ran > custom-ran'
      position: pre_task
`);

    const result = await handleTaskStart({ task_id: "1.1.1", owner_id: "owner" }, stateManager, null, root);

    expect(result.isError).toBe(true);
    expect(stateManager.getTask("1.1.1").status).toBe("pending");
    expect(stateManager.getTask("1.1.1").lease).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, ".rigor", "evidence"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("reports the global config path for unresolved global Gate 0 commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "rigor-task-start-readiness-"));
    const stateManager = new StateManager(root);
    const globalPath = getGlobalConfigPath();
    const prior = existsSync(globalPath) ? readFileSync(globalPath, "utf-8") : null;
    stateManager.init("plan.md", makePhases());
    mkdirSync(dirname(globalPath), { recursive: true });
    writeFileSync(globalPath, "gates:\n  gate_0:\n    checks:\n      - name: tests\n        command: '${lang.test_command}'\n", "utf-8");

    try {
      const result = await handleTaskStart({ task_id: "1.1.1", owner_id: "owner" }, stateManager, null, root);
      expect(result.isError).toBe(true);
      const text = result.content.find((content) => content.type === "text")?.text;
      expect(text).toContain(`global_config (${globalPath})`);
      expect(text).not.toContain("core_defaults");
    } finally {
      if (prior === null) rmSync(globalPath, { force: true });
      else writeFileSync(globalPath, prior, "utf-8");
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts when every configured Gate 0 command is explicit and runnable", async () => {
    const root = mkdtempSync(join(tmpdir(), "rigor-task-start-readiness-"));
    const stateManager = new StateManager(root);
    stateManager.init("plan.md", makePhases());
    writeConfig(root, `
gates:
  gate_0:
    checks:
      - name: runtime
        command: "node --version"
  gate_1:
    enabled: false
`);

    const result = await handleTaskStart({ task_id: "1.1.1", owner_id: "owner" }, stateManager, null, root);

    expect(result.isError).toBeUndefined();
    expect(stateManager.getTask("1.1.1").status).toBe("doing");
    expect(stateManager.getTask("1.1.1").lease?.owner_id).toBe("owner");
    rmSync(root, { recursive: true, force: true });
  });
});
