/**
 * Quality Experiment Report Generator
 *
 * Aggregates scorecard JSON results into a markdown comparison table,
 * delta analysis, and narrative summary.
 *
 * Usage: npx tsx scripts/experiment/report.ts [results-dir]
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScorecardChecks {
  builds: number;
  test_file_exists: number;
  tests_pass: number;
  coverage_above_85: number;
  lint_clean: number;
  tool_registers: number;
  handler_follows_pattern: number;
  tests_follow_pattern: number;
  reads_history_dir: number;
  edge_case_handling: number;
}

interface Scorecard {
  model: string;
  condition: string;
  checks: ScorecardChecks;
  total: number;
  max: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHECK_ORDER: (keyof ScorecardChecks)[] = [
  "builds",
  "test_file_exists",
  "tests_pass",
  "coverage_above_85",
  "lint_clean",
  "tool_registers",
  "handler_follows_pattern",
  "tests_follow_pattern",
  "reads_history_dir",
  "edge_case_handling",
];

const CHECK_LABELS: Record<keyof ScorecardChecks, string> = {
  builds: "Builds",
  test_file_exists: "Test file exists",
  tests_pass: "Tests pass",
  coverage_above_85: "Coverage >= 85%",
  lint_clean: "Lint clean",
  tool_registers: "Tool registers",
  handler_follows_pattern: "Handler pattern",
  tests_follow_pattern: "Test pattern",
  reads_history_dir: "Reads history dir",
  edge_case_handling: "Edge cases",
};

const MODEL_ORDER = ["gemma4", "qwen3", "deepseek"];

const EXPECTED_RUNS = 6;

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

function loadScorecards(dir: string): Scorecard[] {
  if (!existsSync(dir)) {
    return [];
  }

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const results: Scorecard[] = [];

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);

      // Validate required fields
      if (
        typeof data.model !== "string" ||
        typeof data.condition !== "string" ||
        typeof data.checks !== "object" ||
        data.checks === null ||
        typeof data.total !== "number" ||
        typeof data.max !== "number"
      ) {
        console.error(`Skipping malformed file: ${file}`);
        continue;
      }

      results.push(data as Scorecard);
    } catch (err) {
      console.error(`Skipping unreadable file: ${file} - ${err}`);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Data grouping
// ---------------------------------------------------------------------------

type ScorecardMap = Map<string, Map<string, Scorecard>>;

function groupByModelAndCondition(scorecards: Scorecard[]): ScorecardMap {
  const map: ScorecardMap = new Map();

  for (const sc of scorecards) {
    const model = sc.model.toLowerCase();
    if (!map.has(model)) {
      map.set(model, new Map());
    }
    map.get(model)!.set(sc.condition, sc);
  }

  return map;
}

function sortedModels(map: ScorecardMap): string[] {
  const models = Array.from(map.keys());
  return models.sort((a, b) => {
    const ai = MODEL_ORDER.indexOf(a);
    const bi = MODEL_ORDER.indexOf(b);
    const aIdx = ai >= 0 ? ai : MODEL_ORDER.length;
    const bIdx = bi >= 0 ? bi : MODEL_ORDER.length;
    if (aIdx !== bIdx) return aIdx - bIdx;
    return a.localeCompare(b);
  });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

function padRight(str: string, len: number): string {
  return str + " ".repeat(Math.max(0, len - str.length));
}

function padLeft(str: string, len: number): string {
  return " ".repeat(Math.max(0, len - str.length)) + str;
}

function renderMarkdownTable(
  headers: string[],
  alignments: ("left" | "right" | "center")[],
  rows: string[][],
): string {
  // Compute column widths
  const widths = headers.map((h, i) => {
    let max = h.length;
    for (const row of rows) {
      const cell = row[i] ?? "";
      // Strip bold markers for width calculation
      const plain = cell.replace(/\*\*/g, "");
      if (plain.length > max) max = plain.length;
    }
    return max;
  });

  const lines: string[] = [];

  // Header
  const headerCells = headers.map((h, i) => padRight(h, widths[i]));
  lines.push(`| ${headerCells.join(" | ")} |`);

  // Separator with alignment
  const sepCells = widths.map((w, i) => {
    const align = alignments[i] ?? "left";
    if (align === "right") return "-".repeat(Math.max(w, 1)) + ":";
    if (align === "center") return ":" + "-".repeat(Math.max(w - 2, 1)) + ":";
    return "-".repeat(Math.max(w + 1, 2));
  });
  lines.push(`| ${sepCells.join(" | ")} |`);

  // Rows
  for (const row of rows) {
    const cells = row.map((cell, i) => {
      const plain = cell.replace(/\*\*/g, "");
      const boldExtra = cell.length - plain.length;
      return padRight(cell, widths[i] + boldExtra);
    });
    lines.push(`| ${cells.join(" | ")} |`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function checkSymbol(value: number | undefined): string {
  if (value === undefined) return "-";
  return value === 1 ? "Y" : "N";
}

function generateReport(scorecards: Scorecard[]): string {
  const lines: string[] = [];
  const map = groupByModelAndCondition(scorecards);
  const models = sortedModels(map);
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  // --- Header ---
  lines.push("# Quality Experiment Results");
  lines.push("");
  lines.push(`Generated: ${now}`);
  lines.push(`Runs: ${scorecards.length} of ${EXPECTED_RUNS}`);
  lines.push("");

  // --- Comparison table ---
  lines.push("## Comparison Table");
  lines.push("");

  // Build headers: Check | Model1 W | Model1 W/O | Model2 W | ...
  const tableHeaders: string[] = ["Check"];
  const tableAlignments: ("left" | "right" | "center")[] = ["left"];

  for (const model of models) {
    const label = capitalize(model);
    tableHeaders.push(`${label} W`);
    tableHeaders.push(`${label} W/O`);
    tableAlignments.push("center");
    tableAlignments.push("center");
  }

  // Build rows
  const tableRows: string[][] = [];

  for (const checkKey of CHECK_ORDER) {
    const row: string[] = [CHECK_LABELS[checkKey]];
    for (const model of models) {
      const conditions = map.get(model);
      const withRigor = conditions?.get("with-rigor");
      const withoutRigor = conditions?.get("without-rigor");
      row.push(checkSymbol(withRigor?.checks[checkKey]));
      row.push(checkSymbol(withoutRigor?.checks[checkKey]));
    }
    tableRows.push(row);
  }

  // Total row (bold)
  const totalRow: string[] = ["**Total**"];
  for (const model of models) {
    const conditions = map.get(model);
    const withRigor = conditions?.get("with-rigor");
    const withoutRigor = conditions?.get("without-rigor");
    totalRow.push(withRigor ? `**${withRigor.total}**` : "-");
    totalRow.push(withoutRigor ? `**${withoutRigor.total}**` : "-");
  }
  tableRows.push(totalRow);

  lines.push(renderMarkdownTable(tableHeaders, tableAlignments, tableRows));
  lines.push("");

  // --- Delta analysis ---
  lines.push("## Impact Analysis");
  lines.push("");

  const deltaHeaders = ["Model", "With Rigor", "Without Rigor", "Delta", "Improvement"];
  const deltaAlignments: ("left" | "right" | "center")[] = [
    "left",
    "center",
    "center",
    "center",
    "center",
  ];
  const deltaRows: string[][] = [];

  let totalWith = 0;
  let totalWithout = 0;
  let pairCount = 0;

  for (const model of models) {
    const conditions = map.get(model);
    const withRigor = conditions?.get("with-rigor");
    const withoutRigor = conditions?.get("without-rigor");

    const wScore = withRigor?.total;
    const woScore = withoutRigor?.total;
    const max = withRigor?.max ?? withoutRigor?.max ?? 10;

    if (wScore !== undefined && woScore !== undefined) {
      const delta = wScore - woScore;
      const deltaSign = delta >= 0 ? "+" : "";
      const improvement =
        woScore > 0
          ? `${deltaSign}${Math.round((delta / woScore) * 100)}%`
          : delta > 0
            ? "+inf"
            : "0%";

      deltaRows.push([
        capitalize(model),
        `${wScore}/${max}`,
        `${woScore}/${max}`,
        `${deltaSign}${delta}`,
        improvement,
      ]);

      totalWith += wScore;
      totalWithout += woScore;
      pairCount++;
    } else {
      deltaRows.push([
        capitalize(model),
        wScore !== undefined ? `${wScore}/${max}` : "-",
        woScore !== undefined ? `${woScore}/${max}` : "-",
        "-",
        "-",
      ]);
    }
  }

  // Average row
  if (pairCount > 0) {
    const avgWith = totalWith / pairCount;
    const avgWithout = totalWithout / pairCount;
    const avgDelta = avgWith - avgWithout;
    const avgDeltaSign = avgDelta >= 0 ? "+" : "";
    const avgImprovement =
      avgWithout > 0
        ? `${avgDeltaSign}${Math.round((avgDelta / avgWithout) * 100)}%`
        : avgDelta > 0
          ? "+inf"
          : "0%";

    deltaRows.push([
      "**Average**",
      `**${avgWith.toFixed(1)}**`,
      `**${avgWithout.toFixed(1)}**`,
      `**${avgDeltaSign}${avgDelta.toFixed(1)}**`,
      `**${avgImprovement}**`,
    ]);
  }

  lines.push(renderMarkdownTable(deltaHeaders, deltaAlignments, deltaRows));
  lines.push("");

  // --- Summary ---
  lines.push("## Summary");
  lines.push("");

  // Find highest scoring model overall
  let bestModel = "";
  let bestTotal = -1;
  for (const model of models) {
    const conditions = map.get(model);
    const withRigor = conditions?.get("with-rigor");
    if (withRigor && withRigor.total > bestTotal) {
      bestTotal = withRigor.total;
      bestModel = model;
    }
  }

  if (bestModel) {
    lines.push(
      `- **Highest scorer**: ${capitalize(bestModel)} with-rigor at ${bestTotal}/${models.length > 0 ? map.get(bestModel)?.get("with-rigor")?.max ?? 10 : 10}.`,
    );
  }

  // Check consistency of with-rigor outperforming without-rigor
  let withWins = 0;
  let withTies = 0;
  let withLosses = 0;

  for (const model of models) {
    const conditions = map.get(model);
    const w = conditions?.get("with-rigor")?.total;
    const wo = conditions?.get("without-rigor")?.total;
    if (w !== undefined && wo !== undefined) {
      if (w > wo) withWins++;
      else if (w === wo) withTies++;
      else withLosses++;
    }
  }

  if (pairCount > 0) {
    if (withWins === pairCount) {
      lines.push(
        `- **Consistency**: with-rigor outperformed without-rigor across all ${pairCount} models.`,
      );
    } else if (withWins > withLosses) {
      lines.push(
        `- **Consistency**: with-rigor outperformed without-rigor in ${withWins} of ${pairCount} models (${withTies} ties, ${withLosses} losses).`,
      );
    } else if (withWins === withLosses) {
      lines.push(
        `- **Consistency**: with-rigor and without-rigor performed equally overall (${withWins} wins, ${withLosses} losses, ${withTies} ties).`,
      );
    } else {
      lines.push(
        `- **Consistency**: without-rigor outperformed with-rigor in ${withLosses} of ${pairCount} models.`,
      );
    }
  }

  // Find checks that benefited most from gate enforcement
  const checkBenefits: { key: keyof ScorecardChecks; count: number }[] = [];

  for (const checkKey of CHECK_ORDER) {
    let benefitCount = 0;
    for (const model of models) {
      const conditions = map.get(model);
      const w = conditions?.get("with-rigor")?.checks[checkKey];
      const wo = conditions?.get("without-rigor")?.checks[checkKey];
      if (w === 1 && wo === 0) {
        benefitCount++;
      }
    }
    if (benefitCount > 0) {
      checkBenefits.push({ key: checkKey, count: benefitCount });
    }
  }

  checkBenefits.sort((a, b) => b.count - a.count);

  if (checkBenefits.length > 0) {
    // Checks that benefited across multiple models
    const threshold = Math.max(2, Math.ceil(pairCount / 2));
    const topBenefits = checkBenefits.filter((b) => b.count >= threshold);

    if (topBenefits.length > 0) {
      const benefitList = topBenefits
        .map((b) => `${CHECK_LABELS[b.key]} (${b.count}/${pairCount} models)`)
        .join(", ");
      lines.push(
        `- **Most impacted by gates**: ${benefitList} - these checks passed with-rigor but failed without across multiple models.`,
      );
    } else {
      // Show top 3 even if they only affected 1 model
      const top3 = checkBenefits.slice(0, 3);
      const benefitList = top3
        .map((b) => `${CHECK_LABELS[b.key]} (${b.count} model${b.count > 1 ? "s" : ""})`)
        .join(", ");
      lines.push(
        `- **Checks improved by gates**: ${benefitList}.`,
      );
    }
  }

  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const resultsDir = resolve(
    process.argv[2] ?? join(process.cwd(), "scripts", "experiment", "results"),
  );

  const scorecards = loadScorecards(resultsDir);

  if (scorecards.length === 0) {
    console.log(`No scorecard results found in: ${resultsDir}`);
    console.log("Run scorecard.sh with --output to generate result JSON files.");
    process.exit(0);
  }

  const report = generateReport(scorecards);

  // Write to stdout
  console.log(report);

  // Write to file
  const outputPath = join(resultsDir, "report.md");
  try {
    writeFileSync(outputPath, report + "\n", "utf-8");
    console.error(`Report written to: ${outputPath}`);
  } catch (err) {
    console.error(`Failed to write report file: ${err}`);
  }
}

main();
