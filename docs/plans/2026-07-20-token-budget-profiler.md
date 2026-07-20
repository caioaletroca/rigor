# Token Budget Profiler Implementation Plan

> **For implementers:** This is a rolling-wave plan. Phase 1 tasks are
> dispatch-ready. Later phases are epic-level only -- elaborate them against
> the real codebase when execution reaches them.
> This document is the living source of truth -- task elaboration for later
> phases is written back into it during execution.

**Goal:** Build a script that profiles Rigor's token footprint across skills, agents, and MCP tools, then maps it against common context windows to determine which models can run Rigor.

**Architecture:** Standalone TypeScript script in `scripts/` (outside `src/` since it's a dev tool, not part of the server). Reads files from disk, counts characters, divides by 4 for token approximation, and outputs a markdown compatibility matrix to stdout.

**Tech Stack:** TypeScript, Node.js `fs` and `path` (no external dependencies)

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | Script runs, produces a complete report with all 4 layers | 1.1, 1.2, 1.3 | Detailed |
| 2 | npm script integration, report formatting polish, optional file output | 2.1 | Epic-level |

---

## Phase 1: Working Profiler

### Epic 1.1: Token Counting Foundation

**Goal:** A function that reads files by glob pattern, counts tokens, and returns structured inventory data.
**Scope:** `scripts/token-budget.ts`
**Dependencies:** none
**Done when:**
- Given a glob pattern, returns an array of `{ path, bytes, tokens, classification }` objects
- Token count uses chars/4 approximation
- Classification is determined by file path (core vs software-domain for agents, core vs on-demand for skills)
**Status:** Pending

#### Task 1.1.1: Create script entry point with token counting utility

- [ ] Done

**Context:** No `scripts/` directory exists yet. The project uses ESM (`"type": "module"` in `package.json`). TypeScript config compiles `src/` to `dist/`, but this script lives outside `src/` since it's a dev tool. It will need its own compilation step or run via `tsx`/`npx ts-node`.

**Implementation vision:** Create `scripts/token-budget.ts` as a standalone script. Define a `countTokens(content: string): number` function that returns `Math.ceil(content.length / 4)`. Define a `scanFiles(pattern: string, classify: (path: string) => string)` function that uses Node's `fs` and `path` to glob-match files, read each, and return inventory entries. Use `fs.readdirSync` with recursive option or a simple manual recursive walk (no external glob dependency needed since the patterns are simple: `skills/*/SKILL.md` and `agents/**/*.md`).

**Files:**
- Create: `scripts/token-budget.ts`

**Verification:** `npx tsx scripts/token-budget.ts` runs without error and prints at least a debug line showing the file scan results.

**Done when:**
- `countTokens("hello world")` returns 3 (11 chars / 4, rounded up)
- `scanFiles` finds all 19 skill files and 13 agent files
- Each entry has `path`, `bytes`, `tokens`, and `classification` fields

---

#### Task 1.1.2: Add skill and agent classification logic

- [ ] Done

**Context:** After Task 1.1.1, `scanFiles` returns raw entries. Now we need to classify them. The design defines two classification schemes:

Skills classification (from design doc):
- Core (always loaded during a cycle): `cycle`, `commit`, `review`, `lint`, `plan`, `ship`, `pr`, `init`, `receive-review`
- On-demand (loaded only when explicitly invoked): `brainstorm`, `debug`, `new-skill`, `test-guard`, `test-skill`
- Lang packs: `lang/go`, `lang/ts`, `lang/react`, `lang/py`, `lang/csharp`

Agent classification:
- Core: everything in `agents/core/` (6 files)
- Software-domain: everything in `agents/software/` (7 files)

**Implementation vision:** Classification is path-based. For skills, maintain a `CORE_SKILLS` set with the skill directory names listed above. Lang packs are identified by path containing `lang/`. Everything else is on-demand. For agents, `agents/core/` vs `agents/software/` is the split. The classify function receives the relative path and returns a string tag.

**Files:**
- Modify: `scripts/token-budget.ts`

**Verification:** Run the script and verify in the output that `cycle` is classified as `core-skill`, `brainstorm` as `on-demand-skill`, `lang/go` as `lang-pack`, `agents/core/security-reviewer.md` as `core-agent`, and `agents/software/nil-reviewer.md` as `software-agent`.

**Done when:**
- All 19 skills are classified into one of: `core-skill`, `on-demand-skill`, `lang-pack`
- All 13 agents are classified into one of: `core-agent`, `software-agent`

---

### Epic 1.2: MCP Tool Schema Extraction

**Goal:** Extract MCP tool names and descriptions from source files and estimate their token cost.
**Scope:** `scripts/token-budget.ts`, reads `src/tools/*.ts`
**Dependencies:** Epic 1.1 (uses `countTokens`)
**Done when:**
- Extracts all tool registrations from the source
- Reports per-tool token estimate and total MCP overhead
**Status:** Pending

#### Task 1.2.1: Parse tool registrations from source files

- [ ] Done

**Context:** Tools are registered in `src/tools/*.ts` files via `server.tool()` calls. The pattern is:
```typescript
server.tool(
  "tool_name",
  "Description string",
  { param: z.string().describe("param description") },
  async (params) => { ... }
);
```
The tool files are: `src/tools/cycle.ts`, `src/tools/gate.ts`, `src/tools/review.ts`, `src/tools/recovery.ts`, `src/tools/sync.ts`, `src/tools/scaffold.ts`.

**Implementation vision:** Read each tool file as a string. Use a regex to extract `server.tool(` calls and capture the tool name (first string literal) and description (second string literal). Also capture `.describe("...")` calls within the parameter schema to sum up parameter description tokens. This does not need to be a perfect parser; it's a profiling estimate. A regex like `/server\.tool\(\s*"([^"]+)",\s*"([^"]+)"/g` gets the name and description. A separate pass with `/\.describe\("([^"]+)"\)/g` gets parameter descriptions. Sum all captured strings' token counts per tool.

**Files:**
- Modify: `scripts/token-budget.ts`

**Verification:** Run the script. It should find all registered tools (cycle_init, cycle_status, task_start, task_complete, review_start, review_submit, accept_start, accept_submit, phase_advance, cycle_reset, task_manage, epic_manage, phase_manage, cycle_diagnose, sync_status, sync_retry, sync_replay, sync_enable, new_lang_pack, new_domain). Verify count is 20 tools.

**Done when:**
- All 20 tools are extracted with name, description tokens, and parameter description tokens
- Total MCP overhead is summed

---

### Epic 1.3: Report Generation and Compatibility Matrix

**Goal:** The script outputs a complete markdown report with per-component token counts and a context window compatibility matrix.
**Scope:** `scripts/token-budget.ts`
**Dependencies:** Epic 1.1 (file scanning), Epic 1.2 (MCP tools)
**Done when:**
- Running the script prints a markdown report to stdout
- Report includes per-component tables for skills, agents, and MCP tools
- Report includes cycle simulation totals (minimal, full)
- Report includes a compatibility matrix against 8k, 16k, 32k, 128k, 200k windows
- Compatibility uses the threshold rules: YES (50%+ free), TIGHT (25-50% free), NO (<25% free)
**Status:** Pending

#### Task 1.3.1: Build the report renderer

- [ ] Done

**Context:** After Epics 1.1 and 1.2, we have three inventories: skills, agents, and MCP tools. Each entry has `path`, `bytes`, `tokens`, and `classification`. Now we need to render this into the markdown report format specified in the design doc.

**Implementation vision:** Create a `renderReport(skills, agents, mcpTools)` function that:
1. Renders a **Skills** table sorted by classification then name, showing path, tokens, and classification
2. Renders an **Agents** table with the same columns
3. Renders an **MCP Tools** table showing tool name, description tokens, param tokens, and total
4. Sums category totals (core skills total, on-demand skills total, lang packs total, core agents total, software agents total, MCP total)

Output is a markdown string printed to stdout via `console.log`.

**Files:**
- Modify: `scripts/token-budget.ts`

**Verification:** Run the script. Output should be valid markdown with three tables. Pipe to a file and verify it renders correctly: `npx tsx scripts/token-budget.ts > /tmp/report.md`.

**Done when:**
- Three tables render with correct data
- Category subtotals shown after each table

---

#### Task 1.3.2: Add cycle simulation scenarios and compatibility matrix

- [ ] Done

**Context:** The design defines three scenarios and a compatibility matrix. After Task 1.3.1, all component token counts are available.

Scenarios from design:
- **Minimal cycle:** cycle skill + 1 implementation agent + 3 core reviewers (security, logic, test) + MCP baseline
- **Full software cycle:** cycle skill + 1 implementation agent + all 10 reviewers (core + software) + MCP baseline
- **MCP baseline:** all tool descriptions (always loaded)

Context windows: 8k, 16k, 32k, 128k, 200k.
Thresholds: component uses < 25% of window = YES, 25-50% = TIGHT, > 50% = NO.
(Inverted from the design's "free space" framing: if the component leaves 50%+ free, it uses <50%, so the check is `tokens < window * 0.5` for YES, `tokens < window * 0.75` for TIGHT.)

**Implementation vision:** Define the three scenarios as named token sums from the inventory data. For each scenario, check against each window size. Render a final **Compatibility Matrix** table with scenario rows and window columns, each cell showing YES/TIGHT/NO. Add a **Findings** section that states the minimum viable context window for each scenario in plain text.

**Files:**
- Modify: `scripts/token-budget.ts`

**Verification:** `npx tsx scripts/token-budget.ts` produces the full report including the compatibility matrix at the bottom. The matrix should have 3 scenario rows and 5 window columns.

**Done when:**
- Three scenarios computed with correct component sums
- Compatibility matrix renders with YES/TIGHT/NO per cell
- Findings section states the minimum viable window per scenario
- Full report is a single coherent markdown document

---

## Phase 2: Polish and Integration

### Epic 2.1: npm script, file output, and formatting

**Goal:** The profiler is runnable via `npm run profile`, optionally writes to a file, and the report formatting is production-quality.
**Scope:** `scripts/token-budget.ts`, `package.json`
**Dependencies:** Phase 1
**Done when:**
- `npm run profile` runs the profiler
- Optional `--output path` flag writes the report to a file instead of stdout
- Report includes a timestamp and Rigor version
- Numbers are formatted with comma separators for readability
**Status:** Pending

*(No tasks yet -- elaborated during execution after Phase 1 lands.)*
