/**
 * Lang pack scaffolding engine.
 *
 * Generates `defaults.yaml` and `SKILL.md` for a new language pack under
 * `skills/lang/<name>/`. Validates naming, prevents overwrites, and
 * optionally registers the pack in the software domain's DOMAIN.md table.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LangPackInput {
  name: string;
  test_command: string;
  lint_command: string;
  coverage_pattern?: string;
  frontend?: boolean;
  a11y_command?: string;
  visual_command?: string;
  e2e_command?: string;
  perf_command?: string;
}

export interface ScaffoldResult {
  success: boolean;
  files_created: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,29}$/;
const BUILTIN_PACKS = new Set(["go", "ts", "react", "py", "csharp"]);

function validateName(name: string): string | null {
  if (!NAME_PATTERN.test(name)) {
    return `Invalid pack name "${name}". Must be 2-30 characters, lowercase alphanumeric and hyphens, starting with a letter.`;
  }
  if (BUILTIN_PACKS.has(name)) {
    return `Pack "${name}" is a built-in lang pack and cannot be overwritten.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Template generators
// ---------------------------------------------------------------------------

function generateDefaultsYaml(input: LangPackInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.name} language pack variables.`);
  lines.push("#");
  lines.push("# These values are injected into domain pack checks via ${lang.*} resolution.");
  lines.push("# The user's .rigor/config.yaml can override any of these.");
  lines.push("");
  lines.push("variables:");
  lines.push(`  lang.test_command: "${input.test_command}"`);
  lines.push(`  lang.lint_command: "${input.lint_command}"`);
  lines.push(`  lang.coverage_pattern: "${input.coverage_pattern ?? "auto"}"`);

  if (input.frontend) {
    lines.push("  # Frontend quality checks");
    lines.push(`  lang.a11y_command: "${input.a11y_command ?? ""}"`);
    lines.push(`  lang.visual_command: "${input.visual_command ?? ""}"`);
    lines.push(`  lang.e2e_command: "${input.e2e_command ?? ""}"`);
    lines.push(`  lang.perf_command: "${input.perf_command ?? ""}"`);
  }

  lines.push("");
  return lines.join("\n");
}

function generateSkillMd(input: LangPackInput): string {
  const displayName = input.name.charAt(0).toUpperCase() + input.name.slice(1);

  const frontendSection = input.frontend
    ? `
## Frontend Quality Checks

| Check | Command | Notes |
|-------|---------|-------|
| Accessibility | \`${input.a11y_command || "TODO"}\` | axe-core or equivalent |
| Visual Regression | \`${input.visual_command || "TODO"}\` | Snapshot tests |
| E2E | \`${input.e2e_command || "TODO"}\` | End-to-end tests |
| Performance | \`${input.perf_command || "TODO"}\` | Lighthouse or equivalent |
`
    : "";

  return `---
name: rigor:lang:${input.name}
description: >-
  ${displayName} language pack — detection heuristics, gate commands, and
  review patterns for ${displayName} projects.
---

# ${displayName} Language Pack

## Detection Heuristics

<!-- TODO: Add detection signals for ${displayName} projects -->
<!-- Example: -->
<!-- | Signal | Confidence | -->
<!-- |--------|------------| -->
<!-- | \`Cargo.toml\` | high | -->
<!-- | \`.rs\` files in src/ | medium | -->

## Gate 0 Commands

| Check | Command | Notes |
|-------|---------|-------|
| Tests | \`${input.test_command}\` | Test runner with coverage |
| Lint | \`${input.lint_command}\` | Linter |
| Coverage | \`${input.coverage_pattern ?? "auto"}\` | Coverage parsing mode |
${frontendSection}
## Gate 8 Review Patterns

<!-- TODO: Add ${displayName}-specific review patterns -->
<!-- Example: -->
<!-- - Check for unsafe unwrap() calls -->
<!-- - Verify error handling patterns -->
<!-- - Review concurrency primitives -->

## Dependencies

<!-- TODO: List required tools -->
<!-- Example: -->
<!-- - \`rustc\` >= 1.70 -->
<!-- - \`cargo\` (included with rustc) -->
`;
}

// ---------------------------------------------------------------------------
// DOMAIN.md registration
// ---------------------------------------------------------------------------

/**
 * Register a new lang pack in the software domain's DOMAIN.md table.
 *
 * Finds the "Available Lang Packs" table and appends a row. If DOMAIN.md
 * doesn't exist or doesn't have the expected table, silently skips.
 */
export function registerLangPackInDomain(
  packName: string,
  variables: string[],
  domainMdPath: string,
): void {
  if (!existsSync(domainMdPath)) return;

  const content = readFileSync(domainMdPath, "utf-8");

  // Find the table header line
  const tableHeaderPattern = "| Language | Pack |";
  const headerIdx = content.indexOf(tableHeaderPattern);
  if (headerIdx === -1) return;

  // Find the end of the table: last line starting with |
  const lines = content.split("\n");
  const headerLineIdx = lines.findIndex((line) => line.includes(tableHeaderPattern));
  if (headerLineIdx === -1) return;

  // Find the last table row (line starting with |)
  let lastTableRowIdx = headerLineIdx;
  for (let i = headerLineIdx + 1; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith("|")) {
      lastTableRowIdx = i;
    } else {
      break;
    }
  }

  const displayName = packName.charAt(0).toUpperCase() + packName.slice(1);
  const varsStr = variables.map((v) => `\`${v}\``).join(", ");
  const newRow = `| ${displayName} | \`rigor:lang:${packName}\` | ${varsStr} |`;

  // Insert after the last table row
  lines.splice(lastTableRowIdx + 1, 0, newRow);

  writeFileSync(domainMdPath, lines.join("\n"), "utf-8");
}

// ---------------------------------------------------------------------------
// Main scaffold function
// ---------------------------------------------------------------------------

export async function scaffoldLangPack(
  input: LangPackInput,
  projectRoot: string,
): Promise<ScaffoldResult> {
  // 1. Validate name
  const nameError = validateName(input.name);
  if (nameError) {
    return { success: false, files_created: [], error: nameError };
  }

  // 2. Check directory doesn't exist
  const packDir = join(projectRoot, "skills", "lang", input.name);
  if (existsSync(packDir)) {
    return {
      success: false,
      files_created: [],
      error: `Lang pack "${input.name}" already exists at ${packDir}. Use a different name.`,
    };
  }

  // 3. Create directory
  mkdirSync(packDir, { recursive: true });

  // 4. Write defaults.yaml
  const defaultsPath = join(packDir, "defaults.yaml");
  writeFileSync(defaultsPath, generateDefaultsYaml(input), "utf-8");

  // 5. Write SKILL.md
  const skillMdPath = join(packDir, "SKILL.md");
  writeFileSync(skillMdPath, generateSkillMd(input), "utf-8");

  const filesCreated = [defaultsPath, skillMdPath];

  // 6. Register in DOMAIN.md
  const domainMdPath = join(
    projectRoot,
    "skills",
    "domain",
    "software",
    "DOMAIN.md",
  );

  const variables = [
    "lang.test_command",
    "lang.lint_command",
    "lang.coverage_pattern",
  ];
  if (input.frontend) {
    variables.push(
      "lang.a11y_command",
      "lang.visual_command",
      "lang.e2e_command",
      "lang.perf_command",
    );
  }

  registerLangPackInDomain(input.name, variables, domainMdPath);

  return { success: true, files_created: filesCreated };
}
