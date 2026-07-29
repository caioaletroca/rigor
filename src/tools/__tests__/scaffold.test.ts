/**
 * Tests for scaffold MCP tool handlers.
 *
 * Tests the extracted handler functions directly -- no MCP transport needed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  handleNewLangPack,
  handleNewDomain,
  discoverDomainScopedSkills,
  mergeSkills,
  handleInstallCommands,
} from "../scaffold.js";
import type { NewLangPackParams, NewDomainParams } from "../scaffold.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TextContent {
  type: "text";
  text: string;
}

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0] as TextContent;
  return first.text;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("new_lang_pack tool", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rigor-scaffold-tool-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns success with file list for valid input", async () => {
    const params: NewLangPackParams = {
      name: "rust",
      test_command: "cargo test",
      lint_command: "cargo clippy",
    };

    const result = await handleNewLangPack(params, tempDir);

    expect(result.isError).toBeUndefined();

    const text = extractText(result);
    expect(text).toContain('Lang pack "rust" created successfully');
    expect(text).toContain("Files created:");
    expect(text).toContain("defaults.yaml");
    expect(text).toContain("SKILL.md");
    expect(text).toContain("Next steps:");
  });

  it("returns error for duplicate pack name", async () => {
    // Create the pack directory first
    const packDir = join(tempDir, "skills", "lang", "kotlin");
    mkdirSync(packDir, { recursive: true });

    const params: NewLangPackParams = {
      name: "kotlin",
      test_command: "gradle test",
      lint_command: "ktlint",
    };

    const result = await handleNewLangPack(params, tempDir);

    expect(result.isError).toBe(true);

    const text = extractText(result);
    expect(text).toContain("already exists");
  });

  it("returns error for invalid name format", async () => {
    const params: NewLangPackParams = {
      name: "My Language",
      test_command: "test",
      lint_command: "lint",
    };

    const result = await handleNewLangPack(params, tempDir);

    expect(result.isError).toBe(true);

    const text = extractText(result);
    expect(text).toContain("Invalid pack name");
  });

  it("full round-trip: creates readable, valid files", async () => {
    // Set up DOMAIN.md for registration check
    const domainDir = join(tempDir, "skills", "domain", "software");
    mkdirSync(domainDir, { recursive: true });
    writeFileSync(
      join(domainDir, "DOMAIN.md"),
      [
        "# Software Domain Pack",
        "",
        "## Available Lang Packs",
        "",
        "| Language | Pack | Variables Provided |",
        "|----------|------|--------------------|",
        "| Go | `rigor:lang:go` | `lang.test_command`, `lang.lint_command`, `lang.coverage_pattern` |",
        "",
        "Trailing text.",
      ].join("\n"),
      "utf-8",
    );

    const params: NewLangPackParams = {
      name: "rust",
      test_command: "cargo test",
      lint_command: "cargo clippy",
      coverage_pattern: "auto",
    };

    const result = await handleNewLangPack(params, tempDir);
    expect(result.isError).toBeUndefined();

    // Verify files exist and are readable
    const defaultsPath = join(tempDir, "skills", "lang", "rust", "defaults.yaml");
    const skillMdPath = join(tempDir, "skills", "lang", "rust", "SKILL.md");

    expect(existsSync(defaultsPath)).toBe(true);
    expect(existsSync(skillMdPath)).toBe(true);

    // Verify defaults.yaml content
    const defaults = readFileSync(defaultsPath, "utf-8");
    expect(defaults).toContain("cargo test");
    expect(defaults).toContain("cargo clippy");

    // Verify SKILL.md content
    const skillMd = readFileSync(skillMdPath, "utf-8");
    expect(skillMd).toContain("rigor:lang:rust");

    // Verify DOMAIN.md was updated
    const domainMd = readFileSync(join(domainDir, "DOMAIN.md"), "utf-8");
    expect(domainMd).toContain("rigor:lang:rust");
  });

  it("defaults coverage_pattern to auto and frontend to false", async () => {
    const params: NewLangPackParams = {
      name: "rust",
      test_command: "cargo test",
      lint_command: "cargo clippy",
    };

    await handleNewLangPack(params, tempDir);

    const defaults = readFileSync(
      join(tempDir, "skills", "lang", "rust", "defaults.yaml"),
      "utf-8",
    );
    expect(defaults).toContain('lang.coverage_pattern: "auto"');
    expect(defaults).not.toContain("lang.a11y_command");
  });
});

// ---------------------------------------------------------------------------
// new_domain tool
// ---------------------------------------------------------------------------

describe("new_domain tool", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rigor-domain-tool-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns success with file list for valid input", async () => {
    const params: NewDomainParams = {
      name: "data-science",
      description: "Data science and ML projects",
    };

    const result = await handleNewDomain(params, tempDir);

    expect(result.isError).toBeUndefined();

    const text = extractText(result);
    expect(text).toContain('Domain pack "data-science" created successfully');
    expect(text).toContain("Files created:");
    expect(text).toContain("defaults.yaml");
    expect(text).toContain("DOMAIN.md");
    expect(text).toContain("Next steps:");
  });

  it("returns error for duplicate domain name", async () => {
    const packDir = join(tempDir, "skills", "domain", "gamedev");
    mkdirSync(packDir, { recursive: true });

    const result = await handleNewDomain({ name: "gamedev" }, tempDir);

    expect(result.isError).toBe(true);

    const text = extractText(result);
    expect(text).toContain("already exists");
  });

  it("returns error for invalid name format", async () => {
    const result = await handleNewDomain({ name: "Bad Name!" }, tempDir);

    expect(result.isError).toBe(true);

    const text = extractText(result);
    expect(text).toContain("Invalid domain name");
  });

  it("passes custom checks through to the scaffold engine", async () => {
    const params: NewDomainParams = {
      name: "ml-ops",
      checks: [
        {
          name: "model-test",
          command: "python validate.py",
          metric_parse: "auto",
          metric_threshold: 90,
          metric_label: "accuracy",
        },
      ],
    };

    const result = await handleNewDomain(params, tempDir);
    expect(result.isError).toBeUndefined();

    const defaults = readFileSync(
      join(tempDir, "skills", "domain", "ml-ops", "defaults.yaml"),
      "utf-8",
    );
    expect(defaults).toContain("model-test");
    expect(defaults).toContain("python validate.py");
    expect(defaults).toContain("threshold: 90");
  });

  it("full round-trip: creates files discoverable by config loader", async () => {
    const params: NewDomainParams = {
      name: "embedded",
      description: "Embedded systems projects",
      detection_signals: ["Makefile with cross-compilation"],
    };

    const result = await handleNewDomain(params, tempDir);
    expect(result.isError).toBeUndefined();

    // Verify files exist
    const defaultsPath = join(tempDir, "skills", "domain", "embedded", "defaults.yaml");
    const domainMdPath = join(tempDir, "skills", "domain", "embedded", "DOMAIN.md");

    expect(existsSync(defaultsPath)).toBe(true);
    expect(existsSync(domainMdPath)).toBe(true);

    // Verify DOMAIN.md content
    const domainMd = readFileSync(domainMdPath, "utf-8");
    expect(domainMd).toContain("Embedded Domain Pack");
    expect(domainMd).toContain("Embedded systems projects");
    expect(domainMd).toContain("Makefile with cross-compilation");
  });
});

// ---------------------------------------------------------------------------
// discoverDomainScopedSkills
// ---------------------------------------------------------------------------

describe("discoverDomainScopedSkills", () => {
  let tempDir: string;

  /** Create a domain-scoped skill fixture at skills/domain/<domain>/skills/<leaf>/SKILL.md */
  function writeDomainSkill(domain: string, leaf: string, name: string): void {
    const dir = join(tempDir, "skills", "domain", domain, "skills", leaf);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      [`---`, `name: ${name}`, `description: "Does ${leaf} things. More detail."`, `---`, ``, `# ${name}`, ``].join("\n"),
      "utf-8",
    );
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rigor-domain-skills-test-"));
    // software ships a worktree skill; data-science ships a profile skill
    writeDomainSkill("software", "worktree", "rigor:worktree");
    writeDomainSkill("data-science", "profile", "rigor:profile");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns the active domain's skills (software)", () => {
    const skills = discoverDomainScopedSkills(tempDir, "software");
    expect(skills.map((s) => s.shortName)).toEqual(["worktree"]);
    expect(skills[0].name).toBe("rigor:worktree");
    expect(skills[0].skillPath).toContain(join("software", "skills", "worktree", "SKILL.md"));
    expect(skills[0].description).toContain("Does worktree things");
  });

  it("returns only the matching domain, not others", () => {
    const skills = discoverDomainScopedSkills(tempDir, "data-science");
    expect(skills.map((s) => s.shortName)).toEqual(["profile"]);
  });

  it("returns [] when the active domain is undefined and not global", () => {
    expect(discoverDomainScopedSkills(tempDir, undefined)).toEqual([]);
  });

  it("returns skills from every domain when global is true", () => {
    const skills = discoverDomainScopedSkills(tempDir, undefined, { global: true });
    // sorted by shortName: profile, worktree
    expect(skills.map((s) => s.shortName)).toEqual(["profile", "worktree"]);
  });

  it("global:true surfaces all domains even when an activeDomain is given", () => {
    const skills = discoverDomainScopedSkills(tempDir, "software", { global: true });
    expect(skills.map((s) => s.shortName)).toEqual(["profile", "worktree"]);
  });

  it("falls back to rigor:<leaf> when the SKILL.md has no name frontmatter", () => {
    const dir = join(tempDir, "skills", "domain", "software", "skills", "nameless");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\ndescription: "No name here."\n---\n`, "utf-8");
    const skills = discoverDomainScopedSkills(tempDir, "software");
    const nameless = skills.find((s) => s.shortName === "nameless");
    expect(nameless?.name).toBe("rigor:nameless");
  });

  it("ignores domains that ship no skills/ subdirectory", () => {
    // 'embedded' domain has only a DOMAIN.md, no skills/ dir
    mkdirSync(join(tempDir, "skills", "domain", "embedded"), { recursive: true });
    writeFileSync(join(tempDir, "skills", "domain", "embedded", "DOMAIN.md"), "# Embedded", "utf-8");
    expect(discoverDomainScopedSkills(tempDir, "embedded")).toEqual([]);
  });

  it("returns [] when there is no domain directory at all", () => {
    const bare = mkdtempSync(join(tmpdir(), "rigor-bare-test-"));
    try {
      expect(discoverDomainScopedSkills(bare, "software", { global: true })).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// mergeSkills -- de-dup precedence
// ---------------------------------------------------------------------------

describe("mergeSkills", () => {
  const meta = (shortName: string, from: string) => ({
    name: `rigor:${shortName}`,
    shortName,
    description: from,
    skillPath: `/${from}/${shortName}/SKILL.md`,
  });

  it("keeps all skills when there is no name collision", () => {
    const merged = mergeSkills([meta("commit", "top")], [meta("worktree", "domain")]);
    expect(merged.map((s) => s.shortName)).toEqual(["commit", "worktree"]);
  });

  it("drops the domain skill when a top-level skill shares its shortName", () => {
    const merged = mergeSkills([meta("worktree", "top")], [meta("worktree", "domain")]);
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe("top"); // top-level wins
  });

  it("keeps the first domain skill when two domain skills share a shortName", () => {
    const merged = mergeSkills([], [meta("worktree", "d1"), meta("worktree", "d2")]);
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe("d1"); // first domain wins
  });
});

// ---------------------------------------------------------------------------
// install_commands -- domain gating (per-project, writes into a temp root)
// ---------------------------------------------------------------------------

describe("install_commands domain gating", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "rigor-install-gating-test-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** Write a project .rigor/config.yaml with the given domain (or none). */
  function writeConfig(domain?: string): void {
    mkdirSync(join(projectRoot, ".rigor"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".rigor", "config.yaml"),
      domain ? `domain: ${domain}\n` : "gates: {}\n",
      "utf-8",
    );
  }

  it("installs the domain-scoped rigor:worktree command when domain=software", async () => {
    writeConfig("software");
    const result = await handleInstallCommands({ client: "claude", global: false }, projectRoot);
    expect(result.isError).toBeUndefined();
    expect(existsSync(join(projectRoot, ".claude", "commands", "rigor-worktree.md"))).toBe(true);
  });

  it("does NOT install rigor:worktree when a different domain is active", async () => {
    writeConfig("data-science");
    await handleInstallCommands({ client: "claude", global: false }, projectRoot);
    expect(existsSync(join(projectRoot, ".claude", "commands", "rigor-worktree.md"))).toBe(false);
    // top-level skills still install (sanity: the commit command exists)
    expect(existsSync(join(projectRoot, ".claude", "commands", "rigor-commit.md"))).toBe(true);
  });

  it("does NOT install rigor:worktree when no domain is configured", async () => {
    writeConfig(undefined);
    await handleInstallCommands({ client: "claude", global: false }, projectRoot);
    expect(existsSync(join(projectRoot, ".claude", "commands", "rigor-worktree.md"))).toBe(false);
  });

  it("does not throw when the project config is malformed (top-level still installs)", async () => {
    mkdirSync(join(projectRoot, ".rigor"), { recursive: true });
    writeFileSync(join(projectRoot, ".rigor", "config.yaml"), "domain: : : [broken yaml", "utf-8");
    const result = await handleInstallCommands({ client: "claude", global: false }, projectRoot);
    expect(result.isError).toBeUndefined();
    expect(existsSync(join(projectRoot, ".claude", "commands", "rigor-worktree.md"))).toBe(false);
    expect(existsSync(join(projectRoot, ".claude", "commands", "rigor-commit.md"))).toBe(true);
  });
});
