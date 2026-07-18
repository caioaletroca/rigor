/**
 * Tests for scaffold MCP tool handlers.
 *
 * Tests the extracted handler functions directly -- no MCP transport needed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleNewLangPack, handleNewDomain } from "../scaffold.js";
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
