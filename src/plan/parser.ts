/**
 * Plan parser -- reads a plan.md (rigor:plan format) and extracts the
 * phase-epic-task hierarchy into typed structures.
 *
 * The parser is read-only: it never modifies the plan file.
 */

import { readFileSync, existsSync } from "node:fs";
import { PlanParseError } from "./errors.js";
import type {
  ParsedPlan,
  ParsedPhase,
  ParsedEpic,
  ParsedTask,
} from "./types.js";

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

const TITLE_RE = /^#\s+(.+)$/m;
const PHASE_TABLE_ROW_RE =
  /^\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*([\d.,\s]+)\s*\|\s*(.+?)\s*\|$/gm;
const EPIC_HEADER_RE = /^###\s+Epic\s+(\d+\.\d+):\s+(.+)$/gm;
const TASK_HEADER_RE = /^####\s+Task\s+(\d+\.\d+\.\d+):\s+(.+)$/gm;
const BOLD_FIELD_RE = /\*\*([^*]+):\*\*\s*(.+)/;
const CHECKBOX_RE = /^-\s+\[([ xX])\]\s+Done/m;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract a bold-prefixed field value from a block of text.
 * Matches `**Label:** value` where the value may span to the next bold field
 * or heading.
 */
function extractField(block: string, label: string): string {
  // Build a regex that finds **Label:** and captures everything until the
  // next bold field, heading, horizontal rule, or end of string.
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `\\*\\*${escaped}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\*\\*[^*]+:\\*\\*|\\n#{1,6}\\s|\\n---|\n\\n-\\s+\\[|$)`,
  );
  const match = re.exec(block);
  return match ? match[1].trim() : "";
}

/**
 * Parse the Phase Overview markdown table from the plan content.
 */
function parsePhaseTable(content: string): ParsedPhase[] {
  // Reset regex state
  PHASE_TABLE_ROW_RE.lastIndex = 0;

  const phases: ParsedPhase[] = [];
  let match: RegExpExecArray | null;

  while ((match = PHASE_TABLE_ROW_RE.exec(content)) !== null) {
    const phaseId = parseInt(match[1], 10);
    const milestone = match[2].trim();
    const epicIdsRaw = match[3].trim();
    const status = match[4].trim();

    const epic_ids = epicIdsRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    phases.push({
      id: phaseId,
      milestone,
      epic_ids,
      status,
      epics: [],
    });
  }

  return phases;
}

/**
 * Parse all epics from the plan content.
 */
function parseEpics(content: string): ParsedEpic[] {
  EPIC_HEADER_RE.lastIndex = 0;

  const epics: ParsedEpic[] = [];
  const epicMatches: Array<{ id: string; name: string; startIndex: number }> =
    [];

  let match: RegExpExecArray | null;
  while ((match = EPIC_HEADER_RE.exec(content)) !== null) {
    epicMatches.push({
      id: match[1],
      name: match[2].trim(),
      startIndex: match.index,
    });
  }

  for (let i = 0; i < epicMatches.length; i++) {
    const epicMatch = epicMatches[i];
    const blockStart = epicMatch.startIndex;
    const blockEnd =
      i + 1 < epicMatches.length
        ? epicMatches[i + 1].startIndex
        : content.length;
    const block = content.slice(blockStart, blockEnd);

    const goal = extractField(block, "Goal");
    const scope = extractField(block, "Scope");
    const dependencies = extractField(block, "Dependencies");
    const done_when = extractField(block, "Done when");
    const status = extractField(block, "Status") || "Pending";

    const tasks = parseTasks(block);

    epics.push({
      id: epicMatch.id,
      name: epicMatch.name,
      goal,
      scope,
      dependencies,
      done_when,
      status,
      tasks,
    });
  }

  return epics;
}

/**
 * Parse tasks from an epic block.
 */
function parseTasks(epicBlock: string): ParsedTask[] {
  TASK_HEADER_RE.lastIndex = 0;

  const tasks: ParsedTask[] = [];
  const taskMatches: Array<{ id: string; name: string; startIndex: number }> =
    [];

  let match: RegExpExecArray | null;
  while ((match = TASK_HEADER_RE.exec(epicBlock)) !== null) {
    taskMatches.push({
      id: match[1],
      name: match[2].trim(),
      startIndex: match.index,
    });
  }

  for (let i = 0; i < taskMatches.length; i++) {
    const taskMatch = taskMatches[i];
    const blockStart = taskMatch.startIndex;
    const blockEnd =
      i + 1 < taskMatches.length
        ? taskMatches[i + 1].startIndex
        : epicBlock.length;
    const block = epicBlock.slice(blockStart, blockEnd);

    const checkboxMatch = CHECKBOX_RE.exec(block);
    const done = checkboxMatch
      ? checkboxMatch[1].toLowerCase() === "x"
      : false;

    const context = extractField(block, "Context");
    const verification = extractField(block, "Verification");
    const done_when = extractField(block, "Done when");

    tasks.push({
      id: taskMatch.id,
      name: taskMatch.name,
      done,
      context,
      verification,
      done_when,
    });
  }

  return tasks;
}

/**
 * Extract a top-level header field (Goal, Architecture, Tech Stack) from
 * the plan preamble (between H1 and Phase Overview).
 */
function extractHeaderField(preamble: string, label: string): string {
  const match = BOLD_FIELD_RE.exec(
    preamble
      .split("\n")
      .find((line) => {
        const m = BOLD_FIELD_RE.exec(line);
        return m !== null && m[1] === label;
      }) ?? "",
  );
  return match ? match[2].trim() : "";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a plan.md file and extract the full phase-epic-task hierarchy.
 *
 * @param filePath - Absolute or relative path to the plan markdown file.
 * @returns The parsed plan structure.
 * @throws {PlanParseError} If the file is missing, has no title, or has no
 *   Phase Overview table.
 */
export function parsePlan(filePath: string): ParsedPlan {
  if (!existsSync(filePath)) {
    throw new PlanParseError(`Plan file not found: ${filePath}`);
  }

  const content = readFileSync(filePath, "utf-8");

  // --- Title (H1) ---
  const titleMatch = TITLE_RE.exec(content);
  if (!titleMatch) {
    throw new PlanParseError(`No title (H1) found in ${filePath}`);
  }
  const title = titleMatch[1].trim();

  // --- Phase Overview table ---
  const phases = parsePhaseTable(content);
  if (phases.length === 0) {
    throw new PlanParseError(
      `No Phase Overview table found in ${filePath}`,
    );
  }

  // --- Preamble fields (between H1 and ## Phase Overview) ---
  const phaseOverviewIndex = content.indexOf("## Phase Overview");
  const preamble =
    phaseOverviewIndex > 0
      ? content.slice(titleMatch.index, phaseOverviewIndex)
      : content.slice(titleMatch.index, titleMatch.index + 1000);

  const goal = extractHeaderField(preamble, "Goal");
  const architecture = extractHeaderField(preamble, "Architecture");
  const tech_stack = extractHeaderField(preamble, "Tech Stack");

  // --- Epics and tasks ---
  const allEpics = parseEpics(content);

  // Assign epics to phases by matching the first digit of the epic id
  // to the phase id.
  for (const epic of allEpics) {
    const phaseId = parseInt(epic.id.split(".")[0], 10);
    const phase = phases.find((p) => p.id === phaseId);
    if (phase) {
      phase.epics.push(epic);
    }
  }

  return {
    title,
    goal,
    architecture,
    tech_stack,
    phases,
  };
}
