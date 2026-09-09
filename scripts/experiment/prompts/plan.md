# Implement cycle_history MCP Tool

> **For implementers:** This is a single-phase plan. All tasks are
> dispatch-ready with full context.

**Goal:** Add a `cycle_history` tool that lists completed development cycles from `.rigor/history/`

**Architecture:** New tool module following the existing handler-plus-registration pattern. A standalone `history.ts` exports the handler for direct testing and a registration function for server wiring.

**Tech Stack:** TypeScript, Node.js 20+, vitest, Zod

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | cycle_history tool works end-to-end with tests and server registration | 1.1 | Detailed |

---

## Phase 1: cycle_history Implementation

### Epic 1.1: cycle_history tool

**Goal:** `cycle_history` returns a sorted, limited list of completed cycle summaries from `.rigor/history/`
**Scope:** `src/tools/`, `src/server.ts`
**Dependencies:** none
**Done when:** tool is registered on the MCP server; handler returns correct JSON for all edge cases (empty dir, missing dir, malformed files, limit parameter); tests pass
**Status:** Pending

#### Task 1.1.1: Create history reader and tool handler

- [ ] Done

**Context:** The tool registration pattern is at `src/tools/cycle.ts:202-224` -- each tool module exports a `registerXTools` function calling `server.tool()` with inline Zod schemas, plus standalone handler functions. The `textResult` helper at `src/tools/cycle.ts:22-27` wraps responses. `CycleState` is defined at `src/state/schema.ts:101-108` with `phases -> epics -> tasks` nesting. Task status values are at `src/state/schema.ts:12`.

**Implementation vision:** Create `src/tools/history.ts` that reads `.rigor/history/*.json` files via `readdirSync`/`readFileSync`. Parse each as `CycleState`, skip malformed files silently. Build a summary object per cycle (cycle_id, plan_path, started_at from created_at, completed_at from updated_at, phase_count, task_count, passed/failed counts by walking phases/epics/tasks). Sort by `updated_at` descending. Apply `limit` parameter (0, omitted, or negative means return all). Export `handleCycleHistory` and `registerHistoryTools` following the cycle.ts pattern.

**Files:**
- Create: `src/tools/history.ts`

**Verification:** `npx vitest run src/tools/__tests__/history.test.ts`

**Done when:** `handleCycleHistory` returns correct JSON array for valid history files; returns empty array for missing or empty directory; skips malformed JSON without error; respects the `limit` parameter

---

#### Task 1.1.2: Write tests for the history handler

- [ ] Done

**Context:** Test pattern is at `src/tools/__tests__/cycle.test.ts:1-50` -- uses vitest with `mkdtempSync` for temp dirs, imports handlers directly, and uses an `extractText` helper to pull text from `CallToolResult`. The `CycleState` shape needed for fixture data is at `src/state/schema.ts:101-108`.

**Implementation vision:** Create a test suite that exercises all four edge cases from the spec: (1) missing `.rigor/history/` directory returns `[]`, (2) empty directory returns `[]`, (3) valid JSON files are parsed and returned sorted by `updated_at` descending, (4) malformed JSON files are silently skipped, (5) `limit` parameter caps results (including 0 and negative values meaning "all"). Build `CycleState` fixture objects inline in the test. Write the history JSON files to the temp dir's `.rigor/history/` path. Call `handleCycleHistory` directly.

**Files:**
- Create: `src/tools/__tests__/history.test.ts`

**Verification:** `npx vitest run src/tools/__tests__/history.test.ts`

**Done when:** All test cases pass covering empty dir, missing dir, valid cycles with sorting, malformed file skipping, and limit behavior

---

#### Task 1.1.3: Wire up registration in index and server

- [ ] Done

**Context:** The barrel export is at `src/tools/index.ts:1-49` -- each module re-exports its registration function, handler functions, and param types. The server import site is at `src/server.ts:17-24` and the registration call site is at `src/server.ts:66-71`.

**Implementation vision:** Add `registerHistoryTools` and `handleCycleHistory` exports to `src/tools/index.ts` following the existing pattern. In `src/server.ts`, add `registerHistoryTools` to the import destructuring (line 18-24) and call `registerHistoryTools(server, projectRoot)` after the existing registration calls (line 71). The registration function needs only `server` and `projectRoot` since it reads from the filesystem directly.

**Files:**
- Modify: `src/tools/index.ts`
- Modify: `src/server.ts`

**Verification:** `npx vitest run src/server.test.ts && npx vitest run src/tools/__tests__/history.test.ts`

**Done when:** `registerHistoryTools` is imported and called in `createServer`; the `cycle_history` tool appears in the server's tool list; all existing tests still pass
