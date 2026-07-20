/**
 * Token Budget Profiler for Rigor
 *
 * Profiles token footprint across skills, agents, and MCP tools,
 * then maps it against common context windows to determine model
 * compatibility.
 *
 * Usage: npx tsx scripts/token-budget.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();

const CORE_SKILLS = new Set([
  "cycle",
  "commit",
  "review",
  "lint",
  "plan",
  "ship",
  "pr",
  "init",
  "receive-review",
]);

const CONTEXT_WINDOWS = [8_000, 16_000, 32_000, 128_000, 200_000];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileEntry {
  path: string;
  bytes: number;
  tokens: number;
  classification: string;
}

interface McpToolEntry {
  name: string;
  descriptionTokens: number;
  paramTokens: number;
  totalTokens: number;
}

interface Scenario {
  name: string;
  tokens: number;
  components: string[];
}

// ---------------------------------------------------------------------------
// Token counting
// ---------------------------------------------------------------------------

function countTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

// ---------------------------------------------------------------------------
// Recursive file walker
// ---------------------------------------------------------------------------

function walkDir(dir: string, pattern: RegExp): string[] {
  const results: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      results.push(...walkDir(fullPath, pattern));
    } else if (pattern.test(entry)) {
      results.push(fullPath);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Skill scanning
// ---------------------------------------------------------------------------

function classifySkill(relPath: string): string {
  // Normalize separators for Windows compatibility
  const normalized = relPath.replace(/\\/g, "/");

  if (normalized.includes("lang/")) {
    return "lang-pack";
  }

  // Extract skill name from path like skills/<name>/SKILL.md
  const parts = normalized.split("/");
  const skillIndex = parts.indexOf("skills");
  if (skillIndex >= 0 && skillIndex + 1 < parts.length) {
    const skillName = parts[skillIndex + 1];
    if (CORE_SKILLS.has(skillName)) {
      return "core-skill";
    }
  }

  return "on-demand-skill";
}

function scanSkills(): FileEntry[] {
  const skillsDir = join(PROJECT_ROOT, "skills");
  const entries: FileEntry[] = [];

  // Top-level skills: skills/*/SKILL.md
  let topLevel: string[];
  try {
    topLevel = readdirSync(skillsDir);
  } catch {
    return entries;
  }

  for (const dir of topLevel) {
    if (dir === "lang" || dir === "domain") continue;
    const skillFile = join(skillsDir, dir, "SKILL.md");
    try {
      const content = readFileSync(skillFile, "utf-8");
      const relPath = relative(PROJECT_ROOT, skillFile).replace(/\\/g, "/");
      entries.push({
        path: relPath,
        bytes: Buffer.byteLength(content, "utf-8"),
        tokens: countTokens(content),
        classification: classifySkill(relPath),
      });
    } catch {
      // Skip if SKILL.md doesn't exist
    }
  }

  // Lang packs: skills/lang/*/SKILL.md
  const langDir = join(skillsDir, "lang");
  let langPacks: string[];
  try {
    langPacks = readdirSync(langDir);
  } catch {
    langPacks = [];
  }

  for (const dir of langPacks) {
    const skillFile = join(langDir, dir, "SKILL.md");
    try {
      const content = readFileSync(skillFile, "utf-8");
      const relPath = relative(PROJECT_ROOT, skillFile).replace(/\\/g, "/");
      entries.push({
        path: relPath,
        bytes: Buffer.byteLength(content, "utf-8"),
        tokens: countTokens(content),
        classification: "lang-pack",
      });
    } catch {
      // Skip if SKILL.md doesn't exist
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Agent scanning
// ---------------------------------------------------------------------------

function classifyAgent(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  if (normalized.includes("agents/core/")) {
    return "core-agent";
  }
  if (normalized.includes("agents/software/")) {
    return "software-agent";
  }
  return "agent";
}

function scanAgents(): FileEntry[] {
  const agentsDir = join(PROJECT_ROOT, "agents");
  const files = walkDir(agentsDir, /\.md$/);
  const entries: FileEntry[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(file, "utf-8");
      const relPath = relative(PROJECT_ROOT, file).replace(/\\/g, "/");
      entries.push({
        path: relPath,
        bytes: Buffer.byteLength(content, "utf-8"),
        tokens: countTokens(content),
        classification: classifyAgent(relPath),
      });
    } catch {
      // Skip unreadable files
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// MCP tool extraction
// ---------------------------------------------------------------------------

function extractMcpTools(): McpToolEntry[] {
  const toolsDir = join(PROJECT_ROOT, "src", "tools");
  const toolFiles = walkDir(toolsDir, /\.ts$/);
  const tools: McpToolEntry[] = [];

  for (const file of toolFiles) {
    // Skip test files and index
    const fileName = file.replace(/\\/g, "/");
    if (fileName.includes("__tests__") || fileName.endsWith("index.ts")) {
      continue;
    }

    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    // Extract server.tool() registrations
    // Handles multiple call signatures:
    //   server.tool("name", "desc", { schema }, handler)
    //   server.tool("name", "desc", handler)        -- no schema
    //   server.tool("name", { schema }, handler)     -- no description
    //
    // Strategy: find each server.tool( call, then extract the tool name
    // from the first string literal. Look ahead for a description (second
    // string literal before a { or async/function).

    // Find all server.tool( positions
    const toolCallRegex = /server\.tool\(\s*\n?\s*"([^"]+)"/g;
    let match: RegExpExecArray | null;

    while ((match = toolCallRegex.exec(content)) !== null) {
      const toolName = match[1];
      const startPos = match.index + match[0].length;

      // Find the end of this server.tool() call by matching balanced parens
      let depth = 1;
      let pos = content.indexOf("(", match.index) + 1;
      // Skip to after the tool name string
      pos = startPos;
      const endPos = findClosingParen(content, match.index);

      const callBody = content.substring(startPos, endPos);

      // Try to extract description -- the next string literal if it comes
      // before a { or async or function keyword
      let descriptionTokens = 0;
      const descMatch = callBody.match(/^\s*,\s*\n?\s*"([^"]+)"/);
      if (descMatch) {
        descriptionTokens = countTokens(descMatch[1]);
      }

      // Extract .describe("...") parameter descriptions within this call
      let paramTokens = 0;
      const describeRegex = /\.describe\(\s*"([^"]+)"\s*\)/g;
      let describeMatch: RegExpExecArray | null;
      while ((describeMatch = describeRegex.exec(callBody)) !== null) {
        paramTokens += countTokens(describeMatch[1]);
      }

      // Also count tokens from the tool name itself (it's sent to the model)
      const nameTokens = countTokens(toolName);

      tools.push({
        name: toolName,
        descriptionTokens: nameTokens + descriptionTokens,
        paramTokens,
        totalTokens: nameTokens + descriptionTokens + paramTokens,
      });
    }
  }

  return tools;
}

function findClosingParen(content: string, fromIndex: number): number {
  const openPos = content.indexOf("(", fromIndex);
  if (openPos === -1) return content.length;

  let depth = 1;
  let i = openPos + 1;
  while (i < content.length && depth > 0) {
    if (content[i] === "(") depth++;
    else if (content[i] === ")") depth--;
    i++;
  }
  return i;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.classification !== b.classification) {
      return a.classification.localeCompare(b.classification);
    }
    return a.path.localeCompare(b.path);
  });
}

function sortTools(tools: McpToolEntry[]): McpToolEntry[] {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function padRight(str: string, len: number): string {
  return str + " ".repeat(Math.max(0, len - str.length));
}

function padLeft(str: string | number, len: number): string {
  const s = String(str);
  return " ".repeat(Math.max(0, len - s.length)) + s;
}

function renderTable(
  headers: string[],
  rows: string[][],
  alignRight: Set<number> = new Set(),
): string {
  // Compute column widths
  const widths = headers.map((h, i) => {
    let max = h.length;
    for (const row of rows) {
      if (row[i] && row[i].length > max) {
        max = row[i].length;
      }
    }
    return max;
  });

  const lines: string[] = [];

  // Header
  const headerLine = headers
    .map((h, i) => (alignRight.has(i) ? padLeft(h, widths[i]) : padRight(h, widths[i])))
    .join(" | ");
  lines.push(`| ${headerLine} |`);

  // Separator
  const sepLine = widths
    .map((w, i) => (alignRight.has(i) ? "-".repeat(w) + ":" : "-".repeat(w + 1)))
    .join("|");
  lines.push(`|${sepLine}|`);

  // Rows
  for (const row of rows) {
    const rowLine = row
      .map((cell, i) =>
        alignRight.has(i) ? padLeft(cell, widths[i]) : padRight(cell, widths[i]),
      )
      .join(" | ");
    lines.push(`| ${rowLine} |`);
  }

  return lines.join("\n");
}

function sumTokens(entries: FileEntry[], classification?: string): number {
  if (!classification) {
    return entries.reduce((sum, e) => sum + e.tokens, 0);
  }
  return entries
    .filter((e) => e.classification === classification)
    .reduce((sum, e) => sum + e.tokens, 0);
}

function compatLabel(tokens: number, window: number): string {
  const usage = tokens / window;
  if (usage <= 0.5) return "YES";
  if (usage <= 0.75) return "TIGHT";
  return "NO";
}

function renderReport(
  skills: FileEntry[],
  agents: FileEntry[],
  mcpTools: McpToolEntry[],
): string {
  const lines: string[] = [];

  lines.push("# Rigor Token Budget Report");
  lines.push("");

  // ---- Skills table ----
  lines.push("## Skills");
  lines.push("");

  const sortedSkills = sortEntries(skills);
  const skillRows = sortedSkills.map((s) => [
    s.path,
    String(s.tokens),
    s.classification,
  ]);

  lines.push(
    renderTable(["Path", "Tokens", "Classification"], skillRows, new Set([1])),
  );

  const coreSkillTokens = sumTokens(skills, "core-skill");
  const onDemandTokens = sumTokens(skills, "on-demand-skill");
  const langPackTokens = sumTokens(skills, "lang-pack");
  const totalSkillTokens = sumTokens(skills);

  lines.push("");
  lines.push("**Subtotals:**");
  lines.push(`- Core skills: ${coreSkillTokens} tokens (${skills.filter((s) => s.classification === "core-skill").length} files)`);
  lines.push(`- On-demand skills: ${onDemandTokens} tokens (${skills.filter((s) => s.classification === "on-demand-skill").length} files)`);
  lines.push(`- Lang packs: ${langPackTokens} tokens (${skills.filter((s) => s.classification === "lang-pack").length} files)`);
  lines.push(`- **Total: ${totalSkillTokens} tokens**`);
  lines.push("");

  // ---- Agents table ----
  lines.push("## Agents");
  lines.push("");

  const sortedAgents = sortEntries(agents);
  const agentRows = sortedAgents.map((a) => [
    a.path,
    String(a.tokens),
    a.classification,
  ]);

  lines.push(
    renderTable(["Path", "Tokens", "Classification"], agentRows, new Set([1])),
  );

  const coreAgentTokens = sumTokens(agents, "core-agent");
  const softwareAgentTokens = sumTokens(agents, "software-agent");
  const totalAgentTokens = sumTokens(agents);

  lines.push("");
  lines.push("**Subtotals:**");
  lines.push(`- Core agents: ${coreAgentTokens} tokens (${agents.filter((a) => a.classification === "core-agent").length} files)`);
  lines.push(`- Software agents: ${softwareAgentTokens} tokens (${agents.filter((a) => a.classification === "software-agent").length} files)`);
  lines.push(`- **Total: ${totalAgentTokens} tokens**`);
  lines.push("");

  // ---- MCP Tools table ----
  lines.push("## MCP Tools");
  lines.push("");

  const sortedTools = sortTools(mcpTools);
  const toolRows = sortedTools.map((t) => [
    t.name,
    String(t.descriptionTokens),
    String(t.paramTokens),
    String(t.totalTokens),
  ]);

  lines.push(
    renderTable(
      ["Tool", "Desc Tokens", "Param Tokens", "Total"],
      toolRows,
      new Set([1, 2, 3]),
    ),
  );

  const totalMcpTokens = mcpTools.reduce((sum, t) => sum + t.totalTokens, 0);
  lines.push("");
  lines.push(`**Total MCP overhead: ${totalMcpTokens} tokens** (${mcpTools.length} tools)`);
  lines.push("");

  // ---- Cycle simulation scenarios ----
  lines.push("## Cycle Simulation Scenarios");
  lines.push("");

  // Identify specific agents by name for scenario building
  const implementationAgent = agents.find((a) =>
    a.path.replace(/\\/g, "/").includes("implementation.md"),
  );
  const securityReviewer = agents.find((a) =>
    a.path.replace(/\\/g, "/").includes("security-reviewer.md"),
  );
  const logicReviewer = agents.find((a) =>
    a.path.replace(/\\/g, "/").includes("logic-reviewer.md"),
  );
  const testReviewer = agents.find((a) =>
    a.path.replace(/\\/g, "/").includes("test-reviewer.md"),
  );

  const cycleSkill = skills.find((s) =>
    s.path.replace(/\\/g, "/").includes("cycle/SKILL.md"),
  );

  // Minimal cycle: cycle skill + implementation agent + 3 core reviewers + MCP baseline
  const minimalCycleTokens =
    (cycleSkill?.tokens ?? 0) +
    (implementationAgent?.tokens ?? 0) +
    (securityReviewer?.tokens ?? 0) +
    (logicReviewer?.tokens ?? 0) +
    (testReviewer?.tokens ?? 0) +
    totalMcpTokens;

  // Full software cycle: cycle skill + implementation agent + all reviewers (core + software) + MCP baseline
  const allReviewerTokens =
    coreAgentTokens -
    (implementationAgent?.tokens ?? 0) -
    (agents.find((a) => a.path.replace(/\\/g, "/").includes("plan-writer.md"))?.tokens ?? 0) -
    (agents.find((a) => a.path.replace(/\\/g, "/").includes("recovery.md"))?.tokens ?? 0) +
    softwareAgentTokens;

  const fullCycleTokens =
    (cycleSkill?.tokens ?? 0) +
    (implementationAgent?.tokens ?? 0) +
    allReviewerTokens +
    totalMcpTokens;

  const scenarios: Scenario[] = [
    {
      name: "MCP baseline (tool descriptions)",
      tokens: totalMcpTokens,
      components: ["All MCP tool descriptions and parameter schemas"],
    },
    {
      name: "Minimal cycle",
      tokens: minimalCycleTokens,
      components: [
        "cycle skill",
        "implementation agent",
        "security-reviewer",
        "logic-reviewer",
        "test-reviewer",
        "MCP baseline",
      ],
    },
    {
      name: "Full software cycle",
      tokens: fullCycleTokens,
      components: [
        "cycle skill",
        "implementation agent",
        "all 10 reviewers (core + software)",
        "MCP baseline",
      ],
    },
  ];

  for (const scenario of scenarios) {
    lines.push(`### ${scenario.name}`);
    lines.push("");
    lines.push(`**Total: ${scenario.tokens} tokens**`);
    lines.push("");
    lines.push("Components:");
    for (const c of scenario.components) {
      lines.push(`- ${c}`);
    }
    lines.push("");
  }

  // ---- Compatibility matrix ----
  lines.push("## Compatibility Matrix");
  lines.push("");

  const windowHeaders = ["Scenario", ...CONTEXT_WINDOWS.map((w) => formatWindow(w))];
  const matrixRows = scenarios.map((s) => [
    s.name,
    ...CONTEXT_WINDOWS.map((w) => compatLabel(s.tokens, w)),
  ]);

  lines.push(renderTable(windowHeaders, matrixRows, new Set()));
  lines.push("");
  lines.push("Legend: YES = uses <50% of window (50%+ free for conversation) | TIGHT = uses 50-75% (25-50% free) | NO = uses >75% (<25% free)");
  lines.push("");

  // ---- Findings ----
  lines.push("## Findings");
  lines.push("");

  for (const scenario of scenarios) {
    let minWindow: string | null = null;
    for (const w of CONTEXT_WINDOWS) {
      const label = compatLabel(scenario.tokens, w);
      if (label === "YES" || label === "TIGHT") {
        minWindow = formatWindow(w);
        break;
      }
    }

    if (minWindow) {
      lines.push(
        `- **${scenario.name}** (${scenario.tokens} tokens): minimum viable window is ${minWindow}`,
      );
    } else {
      lines.push(
        `- **${scenario.name}** (${scenario.tokens} tokens): exceeds all tested context windows`,
      );
    }
  }

  lines.push("");

  return lines.join("\n");
}

function formatWindow(tokens: number): string {
  if (tokens >= 1000) {
    return `${tokens / 1000}k`;
  }
  return String(tokens);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const skills = scanSkills();
  const agents = scanAgents();
  const mcpTools = extractMcpTools();

  const report = renderReport(skills, agents, mcpTools);
  console.log(report);
}

main();
