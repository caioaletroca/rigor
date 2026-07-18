/**
 * Domain pack scaffolding engine.
 *
 * Generates `defaults.yaml` and `DOMAIN.md` for a new domain pack under
 * `skills/domain/<name>/`. Validates naming, prevents overwrites, and
 * produces files that the config loader can discover via
 * `loadDomainPackDefaults()`.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScaffoldResult } from "./lang-pack.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DomainCheckInput {
  name: string;
  command: string;
  metric?: {
    parse: string;
    threshold: number;
    label: string;
  };
}

export interface DomainPackInput {
  name: string;
  description?: string;
  detection_signals?: string[];
  checks?: DomainCheckInput[];
  require_test_files?: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,29}$/;
const BUILTIN_DOMAINS = new Set(["software"]);

function validateDomainName(name: string): string | null {
  if (!NAME_PATTERN.test(name)) {
    return `Invalid domain name "${name}". Must be 2-30 characters, lowercase alphanumeric and hyphens, starting with a letter.`;
  }
  if (BUILTIN_DOMAINS.has(name)) {
    return `Domain "${name}" is a built-in domain pack and cannot be overwritten.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Template generators
// ---------------------------------------------------------------------------

function generateDefaultsYaml(input: DomainPackInput): string {
  const lines: string[] = [];
  const displayName = input.name.charAt(0).toUpperCase() + input.name.slice(1);

  lines.push(`# ${displayName} domain pack defaults.`);
  lines.push("#");
  lines.push("# Gate 0 checks use ${lang.*} placeholders resolved by the active lang pack.");
  lines.push("# The user's .rigor/config.yaml can override any of these.");
  lines.push("");
  lines.push("gates:");
  lines.push("  gate_0:");
  lines.push("    checks:");

  const checks = input.checks ?? [];
  if (checks.length === 0) {
    // Provide the standard tests + lint checks as defaults
    lines.push('      - name: "tests"');
    lines.push('        command: "${lang.test_command}"');
    lines.push("        metric:");
    lines.push('          parse: "${lang.coverage_pattern}"');
    lines.push("          threshold: 85");
    lines.push('          label: "coverage"');
    lines.push('      - name: "lint"');
    lines.push('        command: "${lang.lint_command}"');
  } else {
    for (const check of checks) {
      lines.push(`      - name: "${check.name}"`);
      lines.push(`        command: "${check.command}"`);
      if (check.metric) {
        lines.push("        metric:");
        lines.push(`          parse: "${check.metric.parse}"`);
        lines.push(`          threshold: ${check.metric.threshold}`);
        lines.push(`          label: "${check.metric.label}"`);
      }
    }
  }

  const requireTestFiles = input.require_test_files ?? true;
  lines.push(`    require_test_files: ${requireTestFiles}`);
  lines.push("");

  return lines.join("\n");
}

function generateDomainMd(input: DomainPackInput): string {
  const displayName = input.name.charAt(0).toUpperCase() + input.name.slice(1);
  const description = input.description ?? `${displayName} domain pack`;
  const signals = input.detection_signals ?? [];
  const checks = input.checks ?? [];

  let signalsSection: string;
  if (signals.length > 0) {
    const signalRows = signals
      .map((s) => `| ${s} | medium |`)
      .join("\n");
    signalsSection = `| Signal | Confidence |
|--------|------------|
${signalRows}`;
  } else {
    signalsSection = `<!-- TODO: Add detection signals for ${displayName} projects -->
<!-- Example: -->
<!-- | Signal | Confidence | -->
<!-- |--------|------------| -->
<!-- | \`data/\` directory with .csv or .parquet files | high | -->
<!-- | \`jupyter_notebook_config.py\` | medium | -->`;
  }

  let checksSection: string;
  if (checks.length > 0) {
    const checkDescs = checks
      .map((c) => `- **${c.name}** check: runs \`${c.command}\`${c.metric ? ` and parses ${c.metric.label} against a ${c.metric.threshold}% threshold` : ""}`)
      .join("\n");
    checksSection = checkDescs;
  } else {
    checksSection = `- **tests** check: runs the lang pack's test command and parses coverage against an 85% threshold
- **lint** check: runs the lang pack's lint command
- **require_test_files**: enabled by default`;
  }

  return `# ${displayName} Domain Pack

${description}

## What It Provides

${checksSection}

All commands use \`\${lang.*}\` variable placeholders resolved by the active lang pack.

## Detection Signals

${signalsSection}

## Available Lang Packs

| Language | Pack | Variables Provided |
|----------|------|--------------------|

When no lang pack is active, \`\${lang.*}\` placeholders remain unresolved and the corresponding checks are skipped.
`;
}

// ---------------------------------------------------------------------------
// Main scaffold function
// ---------------------------------------------------------------------------

export async function scaffoldDomainPack(
  input: DomainPackInput,
  projectRoot: string,
): Promise<ScaffoldResult> {
  // 1. Validate name
  const nameError = validateDomainName(input.name);
  if (nameError) {
    return { success: false, files_created: [], error: nameError };
  }

  // 2. Check directory doesn't exist
  const packDir = join(projectRoot, "skills", "domain", input.name);
  if (existsSync(packDir)) {
    return {
      success: false,
      files_created: [],
      error: `Domain pack "${input.name}" already exists at ${packDir}. Use a different name.`,
    };
  }

  // 3. Create directory
  mkdirSync(packDir, { recursive: true });

  // 4. Write defaults.yaml
  const defaultsPath = join(packDir, "defaults.yaml");
  writeFileSync(defaultsPath, generateDefaultsYaml(input), "utf-8");

  // 5. Write DOMAIN.md
  const domainMdPath = join(packDir, "DOMAIN.md");
  writeFileSync(domainMdPath, generateDomainMd(input), "utf-8");

  return { success: true, files_created: [defaultsPath, domainMdPath] };
}
