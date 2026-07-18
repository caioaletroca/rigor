/**
 * Tests for pack discovery and variable validation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverLangPacks,
  discoverDomainPacks,
  validateLangPackVariables,
} from "../discovery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "rigor-discovery-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createLangPack(
  root: string,
  name: string,
  variables: Record<string, string>,
): void {
  const dir = join(root, "skills", "lang", name);
  mkdirSync(dir, { recursive: true });

  const lines = ["variables:"];
  for (const [k, v] of Object.entries(variables)) {
    lines.push(`  ${k}: "${v}"`);
  }
  writeFileSync(join(dir, "defaults.yaml"), lines.join("\n"), "utf-8");
  writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`, "utf-8");
}

function createDomainPack(
  root: string,
  name: string,
  checksYaml: string,
): void {
  const dir = join(root, "skills", "domain", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "defaults.yaml"), checksYaml, "utf-8");
  writeFileSync(join(dir, "DOMAIN.md"), `# ${name}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
// discoverLangPacks
// ---------------------------------------------------------------------------

describe("discoverLangPacks", () => {
  it("discovers custom lang packs in project skills/lang/", () => {
    createLangPack(tempDir, "rust", {
      "lang.test_command": "cargo test",
      "lang.lint_command": "cargo clippy",
    });
    createLangPack(tempDir, "kotlin", {
      "lang.test_command": "gradle test",
      "lang.lint_command": "ktlint",
    });

    const packs = discoverLangPacks(tempDir);

    const names = packs.map((p) => p.name);
    expect(names).toContain("rust");
    expect(names).toContain("kotlin");

    const rust = packs.find((p) => p.name === "rust");
    expect(rust?.source).toBe("custom");
  });

  it("returns empty array when no skills/lang/ directory exists", () => {
    const packs = discoverLangPacks(tempDir);
    // May include built-in packs from the Rigor package
    // but no custom packs from the temp dir
    const customPacks = packs.filter((p) => p.source === "custom");
    expect(customPacks).toHaveLength(0);
  });

  it("ignores directories without defaults.yaml or SKILL.md", () => {
    const dir = join(tempDir, "skills", "lang", "empty-pack");
    mkdirSync(dir, { recursive: true });
    // No files in the directory

    const packs = discoverLangPacks(tempDir);
    const empty = packs.find((p) => p.name === "empty-pack");
    expect(empty).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// discoverDomainPacks
// ---------------------------------------------------------------------------

describe("discoverDomainPacks", () => {
  it("discovers custom domain packs in project skills/domain/", () => {
    createDomainPack(
      tempDir,
      "data-science",
      'gates:\n  gate_0:\n    checks:\n      - name: "tests"\n        command: "${lang.test_command}"',
    );

    const packs = discoverDomainPacks(tempDir);

    const names = packs.map((p) => p.name);
    expect(names).toContain("data-science");

    const ds = packs.find((p) => p.name === "data-science");
    expect(ds?.source).toBe("custom");
  });

  it("returns empty custom packs when no skills/domain/ exists", () => {
    const packs = discoverDomainPacks(tempDir);
    const customPacks = packs.filter((p) => p.source === "custom");
    expect(customPacks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateLangPackVariables
// ---------------------------------------------------------------------------

describe("validateLangPackVariables", () => {
  it("returns valid when all referenced variables are provided", () => {
    createLangPack(tempDir, "rust", {
      "lang.test_command": "cargo test",
      "lang.lint_command": "cargo clippy",
      "lang.coverage_pattern": "auto",
    });
    createDomainPack(
      tempDir,
      "software",
      [
        "gates:",
        "  gate_0:",
        "    checks:",
        '      - name: "tests"',
        '        command: "${lang.test_command}"',
        "        metric:",
        '          parse: "${lang.coverage_pattern}"',
        '      - name: "lint"',
        '        command: "${lang.lint_command}"',
      ].join("\n"),
    );

    const result = validateLangPackVariables(
      join(tempDir, "skills", "lang", "rust"),
      join(tempDir, "skills", "domain", "software"),
    );

    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.provided).toContain("lang.test_command");
    expect(result.provided).toContain("lang.lint_command");
    expect(result.provided).toContain("lang.coverage_pattern");
  });

  it("returns invalid when variables are missing", () => {
    createLangPack(tempDir, "minimal", {
      "lang.test_command": "test",
    });
    createDomainPack(
      tempDir,
      "software",
      [
        "gates:",
        "  gate_0:",
        "    checks:",
        '      - name: "tests"',
        '        command: "${lang.test_command}"',
        '      - name: "lint"',
        '        command: "${lang.lint_command}"',
      ].join("\n"),
    );

    const result = validateLangPackVariables(
      join(tempDir, "skills", "lang", "minimal"),
      join(tempDir, "skills", "domain", "software"),
    );

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("lang.lint_command");
    expect(result.provided).toContain("lang.test_command");
  });

  it("returns valid when domain pack has no defaults.yaml", () => {
    createLangPack(tempDir, "rust", {
      "lang.test_command": "cargo test",
    });

    // Create a domain pack without defaults.yaml
    const domainDir = join(tempDir, "skills", "domain", "empty");
    mkdirSync(domainDir, { recursive: true });
    writeFileSync(join(domainDir, "DOMAIN.md"), "# Empty\n", "utf-8");

    const result = validateLangPackVariables(
      join(tempDir, "skills", "lang", "rust"),
      domainDir,
    );

    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it("returns valid when domain pack has no variable references", () => {
    createLangPack(tempDir, "rust", {
      "lang.test_command": "cargo test",
    });
    createDomainPack(
      tempDir,
      "static",
      [
        "gates:",
        "  gate_0:",
        "    checks:",
        '      - name: "always"',
        '        command: "echo hello"',
      ].join("\n"),
    );

    const result = validateLangPackVariables(
      join(tempDir, "skills", "lang", "rust"),
      join(tempDir, "skills", "domain", "static"),
    );

    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.referenced).toHaveLength(0);
  });

  it("handles lang pack without defaults.yaml", () => {
    // Create lang pack with SKILL.md only
    const langDir = join(tempDir, "skills", "lang", "bare");
    mkdirSync(langDir, { recursive: true });
    writeFileSync(join(langDir, "SKILL.md"), "# Bare\n", "utf-8");

    createDomainPack(
      tempDir,
      "software",
      'gates:\n  gate_0:\n    checks:\n      - name: "tests"\n        command: "${lang.test_command}"',
    );

    const result = validateLangPackVariables(
      langDir,
      join(tempDir, "skills", "domain", "software"),
    );

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("lang.test_command");
    expect(result.provided).toHaveLength(0);
  });
});
