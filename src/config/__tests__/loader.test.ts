import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, migrateGate0Config, loadDomainPackDefaults, resolveVariables } from "../loader.js";
import { DEFAULTS } from "../schema.js";
import type { RigorConfig } from "../schema.js";

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
// migrateGate0Config
// ---------------------------------------------------------------------------

describe("migrateGate0Config", () => {
  function cloneDefaults(): RigorConfig {
    return structuredClone(DEFAULTS);
  }

  it("converts test_command to a tests check with coverage metric", () => {
    const config = cloneDefaults();
    config.gates.gate_0.test_command = "npm test";
    config.gates.gate_0.coverage_threshold = 85;

    migrateGate0Config(config);

    expect(config.gates.gate_0.checks).toHaveLength(1);
    expect(config.gates.gate_0.checks[0]).toEqual({
      name: "tests",
      command: "npm test",
      metric: {
        parse: "auto",
        threshold: 85,
        label: "coverage",
      },
    });
  });

  it("converts lint_command to a lint check", () => {
    const config = cloneDefaults();
    config.gates.gate_0.lint_command = "eslint .";

    migrateGate0Config(config);

    expect(config.gates.gate_0.checks).toHaveLength(1);
    expect(config.gates.gate_0.checks[0]).toEqual({
      name: "lint",
      command: "eslint .",
    });
  });

  it("converts both test and lint commands", () => {
    const config = cloneDefaults();
    config.gates.gate_0.test_command = "vitest run";
    config.gates.gate_0.lint_command = "eslint .";
    config.gates.gate_0.coverage_threshold = 90;

    migrateGate0Config(config);

    expect(config.gates.gate_0.checks).toHaveLength(2);
    expect(config.gates.gate_0.checks[0].name).toBe("tests");
    expect(config.gates.gate_0.checks[1].name).toBe("lint");
  });

  it("does not migrate when checks array is already populated", () => {
    const config = cloneDefaults();
    config.gates.gate_0.test_command = "npm test";
    config.gates.gate_0.checks = [
      { name: "custom", command: "custom-cmd" },
    ];

    migrateGate0Config(config);

    // Should not have added a tests check
    expect(config.gates.gate_0.checks).toHaveLength(1);
    expect(config.gates.gate_0.checks[0].name).toBe("custom");
  });

  it("produces empty checks when no commands are configured", () => {
    const config = cloneDefaults();
    // defaults have empty test_command and lint_command

    migrateGate0Config(config);

    expect(config.gates.gate_0.checks).toHaveLength(0);
  });

  it("omits coverage metric when coverage_threshold is 0", () => {
    const config = cloneDefaults();
    config.gates.gate_0.test_command = "npm test";
    config.gates.gate_0.coverage_threshold = 0;

    migrateGate0Config(config);

    expect(config.gates.gate_0.checks).toHaveLength(1);
    expect(config.gates.gate_0.checks[0].metric).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// loadConfig with migration
// ---------------------------------------------------------------------------

describe("loadConfig migration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rigor-migrate-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("migrates old-format config to checks[] during loadConfig", () => {
    const yaml = `
gates:
  gate_0:
    test_command: "vitest run"
    lint_command: "eslint ."
    coverage_threshold: 85
`;
    writeConfigFile(tmpDir, yaml);

    const config = loadConfig(tmpDir);

    expect(config.gates.gate_0.checks).toHaveLength(2);
    expect(config.gates.gate_0.checks[0].name).toBe("tests");
    expect(config.gates.gate_0.checks[0].metric?.threshold).toBe(85);
    expect(config.gates.gate_0.checks[1].name).toBe("lint");
  });

  it("preserves new-format checks[] without migration", () => {
    const yaml = `
gates:
  gate_0:
    checks:
      - name: typecheck
        command: "npx tsc --noEmit"
`;
    writeConfigFile(tmpDir, yaml);

    const config = loadConfig(tmpDir);

    expect(config.gates.gate_0.checks).toHaveLength(1);
    expect(config.gates.gate_0.checks[0].name).toBe("typecheck");
  });
});

// ---------------------------------------------------------------------------
// Domain pack loading
// ---------------------------------------------------------------------------

describe("loadDomainPackDefaults", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rigor-domain-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads domain pack defaults.yaml from project-local path", () => {
    writeDomainPack(tmpDir, "software", `
gates:
  gate_0:
    checks:
      - name: "tests"
        command: "\${lang.test_command}"
    require_test_files: true
`);

    const result = loadDomainPackDefaults("software", tmpDir);
    expect(result).not.toBeNull();
    expect((result as any).gates.gate_0.require_test_files).toBe(true);
    expect((result as any).gates.gate_0.checks).toHaveLength(1);
    expect((result as any).gates.gate_0.checks[0].name).toBe("tests");
  });

  it("returns null for non-existent domain pack", () => {
    const result = loadDomainPackDefaults("nonexistent", tmpDir);
    expect(result).toBeNull();
  });

  it("returns null for empty domain pack file", () => {
    writeDomainPack(tmpDir, "empty", "");
    const result = loadDomainPackDefaults("empty", tmpDir);
    expect(result).toBeNull();
  });

  it("returns null for malformed YAML in domain pack", () => {
    writeDomainPack(tmpDir, "broken", "  bad:\n    yaml: [\n  oops");
    const result = loadDomainPackDefaults("broken", tmpDir);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadConfig with domain pack merge cascade
// ---------------------------------------------------------------------------

describe("loadConfig with domain pack", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rigor-cascade-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads domain pack defaults between core defaults and user config", () => {
    // Create a domain pack with require_test_files and checks
    writeDomainPack(tmpDir, "software", `
gates:
  gate_0:
    checks:
      - name: "tests"
        command: "\${lang.test_command}"
      - name: "lint"
        command: "\${lang.lint_command}"
    require_test_files: true
`);

    // User config sets domain but does not override checks
    writeConfigFile(tmpDir, `
domain: software
`);

    const config = loadConfig(tmpDir);

    // Domain pack checks should be present
    expect(config.gates.gate_0.checks).toHaveLength(2);
    expect(config.gates.gate_0.checks[0].name).toBe("tests");
    expect(config.gates.gate_0.checks[1].name).toBe("lint");
    expect(config.gates.gate_0.require_test_files).toBe(true);
    // Core defaults for other sections should be preserved
    expect(config.commit).toEqual(DEFAULTS.commit);
    expect(config.ship).toEqual(DEFAULTS.ship);
  });

  it("user config overrides domain pack defaults", () => {
    writeDomainPack(tmpDir, "software", `
gates:
  gate_0:
    checks:
      - name: "tests"
        command: "\${lang.test_command}"
      - name: "lint"
        command: "\${lang.lint_command}"
    require_test_files: true
`);

    // User provides their own checks, overriding domain pack
    writeConfigFile(tmpDir, `
domain: software
gates:
  gate_0:
    checks:
      - name: "custom-test"
        command: "my-test-runner"
    require_test_files: false
`);

    const config = loadConfig(tmpDir);

    // User's checks replace domain pack checks (arrays replace)
    expect(config.gates.gate_0.checks).toHaveLength(1);
    expect(config.gates.gate_0.checks[0].name).toBe("custom-test");
    expect(config.gates.gate_0.checks[0].command).toBe("my-test-runner");
    expect(config.gates.gate_0.require_test_files).toBe(false);
  });

  it("returns core defaults when domain is not set", () => {
    writeConfigFile(tmpDir, `
gates:
  gate_0:
    coverage_threshold: 90
`);

    const config = loadConfig(tmpDir);

    // No domain pack loaded, just core defaults + user override
    expect(config.domain).toBeUndefined();
    expect(config.gates.gate_0.coverage_threshold).toBe(90);
    expect(config.gates.gate_0.checks).toEqual([]);
  });

  it("ignores domain pack if domain pack file does not exist", () => {
    writeConfigFile(tmpDir, `
domain: nonexistent
`);

    const config = loadConfig(tmpDir);

    // Should still work, just no domain pack applied
    expect(config.domain).toBe("nonexistent");
    expect(config.gates.gate_0.checks).toEqual([]);
  });

  it("preserves the domain field on the loaded config", () => {
    writeDomainPack(tmpDir, "software", `
gates:
  gate_0:
    require_test_files: true
`);
    writeConfigFile(tmpDir, `
domain: software
`);

    const config = loadConfig(tmpDir);
    expect(config.domain).toBe("software");
  });
});

// ---------------------------------------------------------------------------
// Variable resolution
// ---------------------------------------------------------------------------

describe("resolveVariables", () => {
  it("replaces variables in simple strings", () => {
    const result = resolveVariables("${lang.test_command}", {
      "lang.test_command": "npm test",
    });
    expect(result).toBe("npm test");
  });

  it("replaces multiple variables in a string", () => {
    const result = resolveVariables("${a} and ${b}", {
      a: "hello",
      b: "world",
    });
    expect(result).toBe("hello and world");
  });

  it("resolves variables in nested objects", () => {
    const obj = {
      gates: {
        gate_0: {
          checks: [
            { name: "tests", command: "${lang.test_command}" },
            { name: "lint", command: "${lang.lint_command}" },
          ],
        },
      },
    };

    const result = resolveVariables(obj, {
      "lang.test_command": "npm test",
      "lang.lint_command": "eslint .",
    }) as any;

    expect(result.gates.gate_0.checks[0].command).toBe("npm test");
    expect(result.gates.gate_0.checks[1].command).toBe("eslint .");
  });

  it("replaces unresolved variables with empty string", () => {
    const result = resolveVariables("${lang.missing}", {});
    expect(result).toBe("");
  });

  it("leaves non-string values untouched", () => {
    const obj = {
      threshold: 85,
      enabled: true,
      items: [1, 2, 3],
      nested: null,
    };

    const result = resolveVariables(obj, {}) as any;

    expect(result.threshold).toBe(85);
    expect(result.enabled).toBe(true);
    expect(result.items).toEqual([1, 2, 3]);
    expect(result.nested).toBeNull();
  });

  it("handles empty variables map gracefully", () => {
    const result = resolveVariables(
      { command: "${lang.test_command}", name: "tests" },
      {},
    ) as any;

    expect(result.command).toBe("");
    expect(result.name).toBe("tests");
  });

  it("resolves variables in arrays of strings", () => {
    const result = resolveVariables(
      ["${a}", "${b}", "plain"],
      { a: "x", b: "y" },
    );
    expect(result).toEqual(["x", "y", "plain"]);
  });

  it("handles strings with no placeholders", () => {
    const result = resolveVariables("no variables here", { a: "val" });
    expect(result).toBe("no variables here");
  });

  it("returns primitives unchanged", () => {
    expect(resolveVariables(42, {})).toBe(42);
    expect(resolveVariables(true, {})).toBe(true);
    expect(resolveVariables(null, {})).toBeNull();
    expect(resolveVariables(undefined, {})).toBeUndefined();
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

function writeDomainPack(root: string, domain: string, content: string): void {
  const dir = join(root, "skills", "domain", domain);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "defaults.yaml"), content, "utf-8");
}
