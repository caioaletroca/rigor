/**
 * Types produced by the plan parser.
 *
 * These are the parser's own output types -- intentionally decoupled from the
 * state module. The server layer maps ParsedPlan into CycleState when
 * initializing a cycle.
 */

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export interface ParsedTask {
  /** Dotted id, e.g. "1.1.1". */
  id: string;
  /** Human-readable task name. */
  name: string;
  /** True when the `- [x] Done` checkbox is checked. */
  done: boolean;
  /** The **Context:** field content. */
  context: string;
  /** The **Verification:** field content. */
  verification: string;
  /** The **Done when:** field content. */
  done_when: string;
}

// ---------------------------------------------------------------------------
// Epic
// ---------------------------------------------------------------------------

export interface ParsedEpic {
  /** Dotted id, e.g. "1.1". */
  id: string;
  /** Human-readable epic name. */
  name: string;
  /** The **Goal:** field content. */
  goal: string;
  /** The **Scope:** field content. */
  scope: string;
  /** The **Dependencies:** field content. */
  dependencies: string;
  /** The **Done when:** field content. */
  done_when: string;
  /** Lifecycle status: Pending, Doing, Done, Failed. */
  status: string;
  /** Tasks within this epic (empty for epic-level-only phases). */
  tasks: ParsedTask[];
}

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

export interface ParsedPhase {
  /** Phase number (1-based). */
  id: number;
  /** Human-readable milestone from the Phase Overview table. */
  milestone: string;
  /** Epic ids listed in the Phase Overview table, e.g. ["1.1", "1.2"]. */
  epic_ids: string[];
  /** "Detailed" or "Epic-level" from the Phase Overview table. */
  status: string;
  /** Epics belonging to this phase. */
  epics: ParsedEpic[];
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface ParsedPlan {
  /** Plan title from the first H1 heading. */
  title: string;
  /** The **Goal:** header field. */
  goal: string;
  /** The **Architecture:** header field. */
  architecture: string;
  /** The **Tech Stack:** header field. */
  tech_stack: string;
  /** Phases extracted from the Phase Overview table and body. */
  phases: ParsedPhase[];
}
