import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../loader.js";
import { DEFAULTS } from "../schema.js";

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rigor-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 1. No config file -> returns full DEFAULTS
  // -----------------------------------------------------------------------
  it("returns DEFAULTS when no config file exists", () => {
    const config = loadConfig(tmpDir);
    expect(config).toEqual(DEFAULTS);
  });

  it("returns a fresh copy, not a reference to DEFAULTS", () => {
    const config = loadConfig(tmpDir);
    config.commit.gpg_sign = true;
    expect(DEFAULTS.commit.gpg_sign).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 2. Valid config with all fields -> returns merged config
  // -----------------------------------------------------------------------
  it("loads a full config and overrides all defaults", () => {
    const fullYaml = `
commit:
  gpg_sign: true
  trailers:
    - key: "Signed-off-by"
      value: "Test User <test@example.com>"
  types:
    - feat
    - fix
  require_scope: false
ship:
  branch_pattern: "<type>-<description>"
  force_push: "ask"
gates:
  gate_0:
    coverage_threshold: 95
    lint_command: "eslint ."
    test_command: "vitest run"
    require_test_files: false
  gate_8:
    reviewers:
      - security
    required_reviewers:
      - security
    max_critical_findings: 1
    max_high_findings: 2
  gate_9:
    require_user_approval: false
`;
    writeConfigFile(tmpDir, fullYaml);

    const config = loadConfig(tmpDir);

    expect(config.commit.gpg_sign).toBe(true);
    expect(config.commit.trailers).toEqual([
      { key: "Signed-off-by", value: "Test User <test@example.com>" },
    ]);
    expect(config.commit.types).toEqual(["feat", "fix"]);
    expect(config.commit.require_scope).toBe(false);
    expect(config.ship.branch_pattern).toBe("<type>-<description>");
    expect(config.ship.force_push).toBe("ask");
    expect(config.gates.gate_0.coverage_threshold).toBe(95);
    expect(config.gates.gate_0.lint_command).toBe("eslint .");
    expect(config.gates.gate_0.test_command).toBe("vitest run");
    expect(config.gates.gate_0.require_test_files).toBe(false);
    expect(config.gates.gate_8.reviewers).toEqual(["security"]);
    expect(config.gates.gate_8.required_reviewers).toEqual(["security"]);
    expect(config.gates.gate_8.max_critical_findings).toBe(1);
    expect(config.gates.gate_8.max_high_findings).toBe(2);
    expect(config.gates.gate_9.require_user_approval).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 3. Partial config -> merges with defaults
  // -----------------------------------------------------------------------
  it("merges partial config with defaults (only gate_0.coverage_threshold)", () => {
    const partialYaml = `
gates:
  gate_0:
    coverage_threshold: 90
`;
    writeConfigFile(tmpDir, partialYaml);

    const config = loadConfig(tmpDir);

    // Overridden value
    expect(config.gates.gate_0.coverage_threshold).toBe(90);

    // Remaining gate_0 defaults preserved
    expect(config.gates.gate_0.lint_command).toBe("");
    expect(config.gates.gate_0.test_command).toBe("");
    expect(config.gates.gate_0.require_test_files).toBe(true);

    // Other sections fully default
    expect(config.commit).toEqual(DEFAULTS.commit);
    expect(config.ship).toEqual(DEFAULTS.ship);
    expect(config.gates.gate_8).toEqual(DEFAULTS.gates.gate_8);
    expect(config.gates.gate_9).toEqual(DEFAULTS.gates.gate_9);
  });

  // -----------------------------------------------------------------------
  // 4. Invalid YAML -> throws with descriptive error
  // -----------------------------------------------------------------------
  it("throws a descriptive error for invalid YAML", () => {
    const badYaml = `
commit:
  gpg_sign: true
  trailers:
    - this is broken
      indentation: wrong
    key: bad
`;
    writeConfigFile(tmpDir, badYaml);

    expect(() => loadConfig(tmpDir)).toThrow(/Failed to parse YAML config/);
    expect(() => loadConfig(tmpDir)).toThrow(
      new RegExp(join(tmpDir, ".rigor", "config.yaml").replace(/\\/g, "\\\\")),
    );
  });

  // -----------------------------------------------------------------------
  // 5. Custom reviewers array -> replaces default entirely
  // -----------------------------------------------------------------------
  it("replaces default reviewers array entirely with custom values", () => {
    const yaml = `
gates:
  gate_8:
    reviewers:
      - custom-reviewer
`;
    writeConfigFile(tmpDir, yaml);

    const config = loadConfig(tmpDir);

    // Array replaced, not merged
    expect(config.gates.gate_8.reviewers).toEqual(["custom-reviewer"]);

    // Other gate_8 defaults preserved (object merge still works)
    expect(config.gates.gate_8.required_reviewers).toEqual(
      DEFAULTS.gates.gate_8.required_reviewers,
    );
    expect(config.gates.gate_8.max_critical_findings).toBe(0);
    expect(config.gates.gate_8.max_high_findings).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Edge: empty / comment-only file -> returns defaults
  // -----------------------------------------------------------------------
  it("returns DEFAULTS for an empty config file", () => {
    writeConfigFile(tmpDir, "");
    expect(loadConfig(tmpDir)).toEqual(DEFAULTS);
  });

  it("returns DEFAULTS for a comment-only config file", () => {
    writeConfigFile(tmpDir, "# just a comment\n");
    expect(loadConfig(tmpDir)).toEqual(DEFAULTS);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeConfigFile(root: string, content: string): void {
  const dir = join(root, ".rigor");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.yaml"), content, "utf-8");
}
