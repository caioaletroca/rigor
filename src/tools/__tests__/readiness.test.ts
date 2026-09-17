import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { handleProjectReadiness } from "../readiness.js";

function body(result: ReturnType<typeof handleProjectReadiness>): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

function fixture(config: string): string {
  const root = mkdtempSync(join(tmpdir(), "rigor-readiness-"));
  execFileSync("git", ["init", "--quiet", root]);
  mkdirSync(join(root, ".rigor"));
  writeFileSync(join(root, ".rigor", "config.yaml"), config);
  return root;
}

describe("project readiness tool", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("reports an explicit root with workspace policy and Gate 0 provenance without mutation", () => {
    const root = fixture("gates:\n  gate_0:\n    checks:\n      - name: test\n        command: npm test\n");
    roots.push(root);
    const before = readdirSync(join(root, ".rigor")).sort();

    const result = handleProjectReadiness({ project_root: root }, process.cwd());
    const readiness = body(result);

    expect(readiness).toMatchObject({
      project_root: root,
      root_source: "explicit",
      workspace_policy: { failures: [] },
      gate_0: {
        ready: true,
        unresolved_variables: [],
        empty_checks: [],
        provenance: { category: "project_config", path: join(root, ".rigor", "config.yaml") },
      },
    });
    expect(readdirSync(join(root, ".rigor")).sort()).toEqual(before);
  });

  it("distinguishes plan-derived and fallback roots while reporting unresolved and empty checks", () => {
    const root = fixture("gates:\n  gate_0:\n    checks:\n      - name: test\n        command: ${lang.test_command}\n      - name: lint\n        command: ''\n");
    roots.push(root);
    const plan = join(root, "plans", "plan.md");
    mkdirSync(join(root, "plans"));
    writeFileSync(plan, "# Plan\n");

    const fromPlan = body(handleProjectReadiness({ plan_path: plan }, process.cwd()));
    expect(fromPlan).toMatchObject({
      project_root: root,
      root_source: "plan",
      gate_0: { ready: false, unresolved_variables: ["lang.test_command"], empty_checks: ["lint"] },
    });

    const fallback = body(handleProjectReadiness({}, root));
    expect(fallback).toMatchObject({ project_root: root, root_source: "fallback" });
    expect(fallback.fallback_warning).toContain("using the server fallback root");
  });
});
