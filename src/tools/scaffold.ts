/**
 * Scaffold MCP tools: new_lang_pack and new_domain.
 *
 * Exported handler functions are pure logic returning CallToolResult,
 * keeping them testable without an MCP transport.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { join } from "node:path";
import {
  scaffoldLangPack,
  scaffoldDomainPack,
  discoverLangPacks,
  discoverDomainPacks,
  validateLangPackVariables,
} from "../scaffold/index.js";
import type { LangPackInput, DomainPackInput, DomainCheckInput } from "../scaffold/index.js";

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function textResult(text: string, isError?: boolean): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// new_lang_pack handler
// ---------------------------------------------------------------------------

export interface NewLangPackParams {
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

export async function handleNewLangPack(
  params: NewLangPackParams,
  projectRoot: string,
): Promise<CallToolResult> {
  const input: LangPackInput = {
    name: params.name,
    test_command: params.test_command,
    lint_command: params.lint_command,
    coverage_pattern: params.coverage_pattern ?? "auto",
    frontend: params.frontend ?? false,
    a11y_command: params.a11y_command,
    visual_command: params.visual_command,
    e2e_command: params.e2e_command,
    perf_command: params.perf_command,
  };

  const result = await scaffoldLangPack(input, projectRoot);

  if (!result.success) {
    return textResult(result.error ?? "Unknown error", true);
  }

  const lines: string[] = [];
  lines.push(`Lang pack "${params.name}" created successfully.`);
  lines.push("");
  lines.push("Files created:");
  for (const f of result.files_created) {
    lines.push(`  - ${f}`);
  }

  // Validate against known domain packs
  const langPackDir = join(projectRoot, "skills", "lang", params.name);
  const domainPacks = discoverDomainPacks(projectRoot);
  for (const dp of domainPacks) {
    const validation = validateLangPackVariables(langPackDir, dp.path);
    if (!validation.valid) {
      lines.push("");
      lines.push(`Warning: Lang pack "${params.name}" is missing variables referenced by domain pack "${dp.name}":`);
      for (const v of validation.missing) {
        lines.push(`  - ${v}`);
      }
    }
  }

  lines.push("");
  lines.push("Next steps:");
  lines.push("  1. Edit SKILL.md to add detection heuristics and review patterns");
  lines.push("  2. Add detection signals to skills/init/SKILL.md if needed");
  lines.push(`  3. Test by setting domain: software and lang_pack: ${params.name} in .rigor/config.yaml`);

  return textResult(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// new_domain handler
// ---------------------------------------------------------------------------

export interface NewDomainParams {
  name: string;
  description?: string;
  detection_signals?: string[];
  checks?: Array<{
    name: string;
    command: string;
    metric_parse?: string;
    metric_threshold?: number;
    metric_label?: string;
  }>;
  require_test_files?: boolean;
}

export async function handleNewDomain(
  params: NewDomainParams,
  projectRoot: string,
): Promise<CallToolResult> {
  const checks: DomainCheckInput[] | undefined = params.checks?.map((c) => {
    const check: DomainCheckInput = {
      name: c.name,
      command: c.command,
    };
    if (c.metric_parse && c.metric_threshold !== undefined && c.metric_label) {
      check.metric = {
        parse: c.metric_parse,
        threshold: c.metric_threshold,
        label: c.metric_label,
      };
    }
    return check;
  });

  const input: DomainPackInput = {
    name: params.name,
    description: params.description,
    detection_signals: params.detection_signals,
    checks,
    require_test_files: params.require_test_files,
  };

  const result = await scaffoldDomainPack(input, projectRoot);

  if (!result.success) {
    return textResult(result.error ?? "Unknown error", true);
  }

  const lines: string[] = [];
  lines.push(`Domain pack "${params.name}" created successfully.`);
  lines.push("");
  lines.push("Files created:");
  for (const f of result.files_created) {
    lines.push(`  - ${f}`);
  }
  lines.push("");
  lines.push("Next steps:");
  lines.push("  1. Edit DOMAIN.md to refine detection signals and documentation");
  lines.push(`  2. Set domain: ${params.name} in .rigor/config.yaml to activate`);
  lines.push("  3. Create lang packs for this domain using new_lang_pack if needed");

  return textResult(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerScaffoldTools(
  server: McpServer,
  projectRoot: string,
): void {
  server.tool(
    "new_lang_pack",
    "Scaffold a new language pack with defaults.yaml and SKILL.md",
    {
      name: z.string().describe("Pack name (lowercase, alphanumeric + hyphens, 2-30 chars)"),
      test_command: z.string().describe("Test command (e.g. 'cargo test', 'go test ./...')"),
      lint_command: z.string().describe("Lint command (e.g. 'cargo clippy', 'golangci-lint run ./...')"),
      coverage_pattern: z.string().optional().describe("Coverage parsing pattern (default: 'auto')"),
      frontend: z.boolean().optional().describe("Include frontend quality check variables (default: false)"),
      a11y_command: z.string().optional().describe("Accessibility check command (frontend packs only)"),
      visual_command: z.string().optional().describe("Visual regression command (frontend packs only)"),
      e2e_command: z.string().optional().describe("E2E test command (frontend packs only)"),
      perf_command: z.string().optional().describe("Performance check command (frontend packs only)"),
    },
    async (params) => {
      return handleNewLangPack(params, projectRoot);
    },
  );

  server.tool(
    "new_domain",
    "Scaffold a new domain pack with defaults.yaml and DOMAIN.md",
    {
      name: z.string().describe("Domain name (lowercase, alphanumeric + hyphens, 2-30 chars)"),
      description: z.string().optional().describe("Human-readable description of the domain"),
      detection_signals: z.array(z.string()).optional().describe("Signals to detect this domain in a project"),
      checks: z.array(z.object({
        name: z.string().describe("Check name (e.g. 'tests', 'lint')"),
        command: z.string().describe("Command to run (can use ${lang.*} placeholders)"),
        metric_parse: z.string().optional().describe("Metric parsing pattern"),
        metric_threshold: z.number().optional().describe("Metric threshold value"),
        metric_label: z.string().optional().describe("Human-readable metric label"),
      })).optional().describe("Gate 0 check definitions (defaults to tests + lint)"),
      require_test_files: z.boolean().optional().describe("Require test files for new source files (default: true)"),
    },
    async (params) => {
      return handleNewDomain(params, projectRoot);
    },
  );
}
