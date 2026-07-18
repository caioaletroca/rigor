/**
 * Tests for lang pack scaffolding engine.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { scaffoldLangPack, registerLangPackInDomain } from "../lang-pack.js";
import type { LangPackInput } from "../lang-pack.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "rigor-scaffold-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// scaffoldLangPack
// ---------------------------------------------------------------------------

describe("scaffoldLangPack", () => {
  it("scaffolds a backend lang pack with correct files", async () => {
    const input: LangPackInput = {
      name: "rust",
      test_command: "cargo test",
      lint_command: "cargo clippy",
    };

    const result = await scaffoldLangPack(input, tempDir);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.files_created).toHaveLength(2);

    // Check defaults.yaml exists and has correct content
    const defaultsPath = join(tempDir, "skills", "lang", "rust", "defaults.yaml");
    expect(existsSync(defaultsPath)).toBe(true);

    const defaultsContent = readFileSync(defaultsPath, "utf-8");
    expect(defaultsContent).toContain('lang.test_command: "cargo test"');
    expect(defaultsContent).toContain('lang.lint_command: "cargo clippy"');
    expect(defaultsContent).toContain('lang.coverage_pattern: "auto"');
    // Backend pack should NOT have frontend variables
    expect(defaultsContent).not.toContain("lang.a11y_command");

    // Check SKILL.md exists
    const skillMdPath = join(tempDir, "skills", "lang", "rust", "SKILL.md");
    expect(existsSync(skillMdPath)).toBe(true);

    const skillContent = readFileSync(skillMdPath, "utf-8");
    expect(skillContent).toContain("rigor:lang:rust");
    expect(skillContent).toContain("Rust Language Pack");
    expect(skillContent).toContain("cargo test");
    expect(skillContent).toContain("cargo clippy");
  });

  it("scaffolds a frontend lang pack with additional variables", async () => {
    const input: LangPackInput = {
      name: "svelte",
      test_command: "npx vitest run --coverage",
      lint_command: "npx eslint .",
      frontend: true,
      a11y_command: "npx axe-core-cli",
      e2e_command: "npx playwright test",
    };

    const result = await scaffoldLangPack(input, tempDir);

    expect(result.success).toBe(true);

    const defaultsPath = join(tempDir, "skills", "lang", "svelte", "defaults.yaml");
    const defaultsContent = readFileSync(defaultsPath, "utf-8");

    // Core variables
    expect(defaultsContent).toContain("lang.test_command");
    expect(defaultsContent).toContain("lang.lint_command");
    expect(defaultsContent).toContain("lang.coverage_pattern");

    // Frontend variables
    expect(defaultsContent).toContain('lang.a11y_command: "npx axe-core-cli"');
    expect(defaultsContent).toContain('lang.visual_command: ""');
    expect(defaultsContent).toContain('lang.e2e_command: "npx playwright test"');
    expect(defaultsContent).toContain('lang.perf_command: ""');

    // SKILL.md should have frontend section
    const skillContent = readFileSync(
      join(tempDir, "skills", "lang", "svelte", "SKILL.md"),
      "utf-8",
    );
    expect(skillContent).toContain("Frontend Quality Checks");
    expect(skillContent).toContain("npx axe-core-cli");
  });

  it("rejects existing pack name (built-in)", async () => {
    const input: LangPackInput = {
      name: "go",
      test_command: "go test ./...",
      lint_command: "golangci-lint run ./...",
    };

    const result = await scaffoldLangPack(input, tempDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain("built-in lang pack");
    expect(result.files_created).toHaveLength(0);
  });

  it("rejects duplicate pack directory", async () => {
    // Create the pack directory first
    const packDir = join(tempDir, "skills", "lang", "kotlin");
    mkdirSync(packDir, { recursive: true });

    const input: LangPackInput = {
      name: "kotlin",
      test_command: "gradle test",
      lint_command: "ktlint",
    };

    const result = await scaffoldLangPack(input, tempDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain("already exists");
    expect(result.files_created).toHaveLength(0);
  });

  it("rejects invalid name with spaces", async () => {
    const result = await scaffoldLangPack(
      { name: "my lang", test_command: "test", lint_command: "lint" },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid pack name");
  });

  it("rejects invalid name with uppercase", async () => {
    const result = await scaffoldLangPack(
      { name: "Rust", test_command: "test", lint_command: "lint" },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid pack name");
  });

  it("rejects name that is too short", async () => {
    const result = await scaffoldLangPack(
      { name: "r", test_command: "test", lint_command: "lint" },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid pack name");
  });

  it("generated defaults.yaml is valid YAML with correct variable keys", async () => {
    const input: LangPackInput = {
      name: "rust",
      test_command: "cargo test",
      lint_command: "cargo clippy",
      coverage_pattern: "auto",
    };

    await scaffoldLangPack(input, tempDir);

    const defaultsPath = join(tempDir, "skills", "lang", "rust", "defaults.yaml");
    const raw = readFileSync(defaultsPath, "utf-8");
    const parsed = parse(raw) as Record<string, Record<string, string>>;

    expect(parsed.variables).toBeDefined();
    expect(parsed.variables["lang.test_command"]).toBe("cargo test");
    expect(parsed.variables["lang.lint_command"]).toBe("cargo clippy");
    expect(parsed.variables["lang.coverage_pattern"]).toBe("auto");
  });

  it("registers pack in DOMAIN.md when it exists", async () => {
    // Create a mock DOMAIN.md
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
        "When no lang pack is active, placeholders remain unresolved.",
      ].join("\n"),
      "utf-8",
    );

    const input: LangPackInput = {
      name: "rust",
      test_command: "cargo test",
      lint_command: "cargo clippy",
    };

    await scaffoldLangPack(input, tempDir);

    const domainMd = readFileSync(join(domainDir, "DOMAIN.md"), "utf-8");
    expect(domainMd).toContain("| Rust | `rigor:lang:rust` |");
    expect(domainMd).toContain("`lang.test_command`");
  });

  it("skips DOMAIN.md registration silently when DOMAIN.md is missing", async () => {
    const input: LangPackInput = {
      name: "rust",
      test_command: "cargo test",
      lint_command: "cargo clippy",
    };

    // No DOMAIN.md exists — should not throw
    const result = await scaffoldLangPack(input, tempDir);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// registerLangPackInDomain
// ---------------------------------------------------------------------------

describe("registerLangPackInDomain", () => {
  it("appends a new row to the Available Lang Packs table", () => {
    const domainDir = join(tempDir, "domain-md");
    mkdirSync(domainDir, { recursive: true });
    const domainMdPath = join(domainDir, "DOMAIN.md");

    writeFileSync(
      domainMdPath,
      [
        "# Domain Pack",
        "",
        "## Available Lang Packs",
        "",
        "| Language | Pack | Variables Provided |",
        "|----------|------|--------------------|",
        "| Go | `rigor:lang:go` | `lang.test_command`, `lang.lint_command`, `lang.coverage_pattern` |",
        "",
        "Some trailing text.",
      ].join("\n"),
      "utf-8",
    );

    registerLangPackInDomain(
      "rust",
      ["lang.test_command", "lang.lint_command", "lang.coverage_pattern"],
      domainMdPath,
    );

    const content = readFileSync(domainMdPath, "utf-8");
    const lines = content.split("\n");

    // The new row should appear after the Go row
    const rustRowIdx = lines.findIndex((l) => l.includes("rigor:lang:rust"));
    expect(rustRowIdx).toBeGreaterThan(-1);

    // The Go row should still be there
    const goRowIdx = lines.findIndex((l) => l.includes("rigor:lang:go"));
    expect(goRowIdx).toBeGreaterThan(-1);
    expect(rustRowIdx).toBeGreaterThan(goRowIdx);

    // Trailing text should still be there
    expect(content).toContain("Some trailing text.");
  });

  it("does nothing when DOMAIN.md does not exist", () => {
    // Should not throw
    registerLangPackInDomain(
      "rust",
      ["lang.test_command"],
      join(tempDir, "nonexistent", "DOMAIN.md"),
    );
  });

  it("does nothing when table header is not found", () => {
    const domainMdPath = join(tempDir, "DOMAIN.md");
    writeFileSync(domainMdPath, "# Some file without a table\n", "utf-8");

    registerLangPackInDomain("rust", ["lang.test_command"], domainMdPath);

    const content = readFileSync(domainMdPath, "utf-8");
    expect(content).not.toContain("rust");
  });
});
