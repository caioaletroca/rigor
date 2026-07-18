/**
 * Tests for domain pack scaffolding engine.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { scaffoldDomainPack } from "../domain-pack.js";
import type { DomainPackInput } from "../domain-pack.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "rigor-domain-scaffold-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// scaffoldDomainPack
// ---------------------------------------------------------------------------

describe("scaffoldDomainPack", () => {
  it("scaffolds a domain pack with default checks", async () => {
    const input: DomainPackInput = {
      name: "data-science",
      description: "Data science and ML projects",
    };

    const result = await scaffoldDomainPack(input, tempDir);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.files_created).toHaveLength(2);

    // Check defaults.yaml
    const defaultsPath = join(tempDir, "skills", "domain", "data-science", "defaults.yaml");
    expect(existsSync(defaultsPath)).toBe(true);

    const defaultsContent = readFileSync(defaultsPath, "utf-8");
    expect(defaultsContent).toContain("${lang.test_command}");
    expect(defaultsContent).toContain("${lang.lint_command}");
    expect(defaultsContent).toContain("require_test_files: true");

    // Check DOMAIN.md
    const domainMdPath = join(tempDir, "skills", "domain", "data-science", "DOMAIN.md");
    expect(existsSync(domainMdPath)).toBe(true);

    const domainMd = readFileSync(domainMdPath, "utf-8");
    expect(domainMd).toContain("Data-science Domain Pack");
    expect(domainMd).toContain("Data science and ML projects");
    expect(domainMd).toContain("Available Lang Packs");
  });

  it("scaffolds with custom checks", async () => {
    const input: DomainPackInput = {
      name: "ml-ops",
      checks: [
        {
          name: "model-validation",
          command: "python validate_model.py",
          metric: {
            parse: "auto",
            threshold: 90,
            label: "accuracy",
          },
        },
        {
          name: "data-lint",
          command: "great_expectations checkpoint run",
        },
      ],
    };

    const result = await scaffoldDomainPack(input, tempDir);
    expect(result.success).toBe(true);

    const defaultsContent = readFileSync(
      join(tempDir, "skills", "domain", "ml-ops", "defaults.yaml"),
      "utf-8",
    );
    expect(defaultsContent).toContain("model-validation");
    expect(defaultsContent).toContain("python validate_model.py");
    expect(defaultsContent).toContain("threshold: 90");
    expect(defaultsContent).toContain("data-lint");
    expect(defaultsContent).toContain("great_expectations checkpoint run");
  });

  it("scaffolds with detection signals", async () => {
    const input: DomainPackInput = {
      name: "embedded",
      detection_signals: [
        "Makefile with cross-compilation targets",
        ".hex or .elf output files",
      ],
    };

    const result = await scaffoldDomainPack(input, tempDir);
    expect(result.success).toBe(true);

    const domainMd = readFileSync(
      join(tempDir, "skills", "domain", "embedded", "DOMAIN.md"),
      "utf-8",
    );
    expect(domainMd).toContain("Makefile with cross-compilation targets");
    expect(domainMd).toContain(".hex or .elf output files");
  });

  it("rejects built-in domain name", async () => {
    const input: DomainPackInput = {
      name: "software",
    };

    const result = await scaffoldDomainPack(input, tempDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain("built-in domain pack");
    expect(result.files_created).toHaveLength(0);
  });

  it("rejects duplicate domain directory", async () => {
    const packDir = join(tempDir, "skills", "domain", "gamedev");
    mkdirSync(packDir, { recursive: true });

    const result = await scaffoldDomainPack({ name: "gamedev" }, tempDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain("already exists");
  });

  it("rejects invalid name with uppercase", async () => {
    const result = await scaffoldDomainPack({ name: "DataScience" }, tempDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid domain name");
  });

  it("rejects name that is too short", async () => {
    const result = await scaffoldDomainPack({ name: "d" }, tempDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid domain name");
  });

  it("generated defaults.yaml is valid YAML loadable by config loader", async () => {
    const input: DomainPackInput = {
      name: "data-science",
      checks: [
        {
          name: "tests",
          command: "${lang.test_command}",
          metric: { parse: "${lang.coverage_pattern}", threshold: 85, label: "coverage" },
        },
      ],
    };

    await scaffoldDomainPack(input, tempDir);

    const raw = readFileSync(
      join(tempDir, "skills", "domain", "data-science", "defaults.yaml"),
      "utf-8",
    );
    const parsed = parse(raw) as {
      gates: { gate_0: { checks: Array<{ name: string; command: string }> } };
    };

    expect(parsed.gates).toBeDefined();
    expect(parsed.gates.gate_0).toBeDefined();
    expect(parsed.gates.gate_0.checks).toBeInstanceOf(Array);
    expect(parsed.gates.gate_0.checks[0].name).toBe("tests");
    expect(parsed.gates.gate_0.checks[0].command).toBe("${lang.test_command}");
  });

  it("sets require_test_files to false when specified", async () => {
    const input: DomainPackInput = {
      name: "docs-only",
      require_test_files: false,
    };

    await scaffoldDomainPack(input, tempDir);

    const content = readFileSync(
      join(tempDir, "skills", "domain", "docs-only", "defaults.yaml"),
      "utf-8",
    );
    expect(content).toContain("require_test_files: false");
  });
});
