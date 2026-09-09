# Quality Experiment Harness Implementation Plan

> **For implementers:** This is a rolling-wave plan. Phase 1 tasks are
> dispatch-ready. Later phases are epic-level only -- elaborate them against
> the real codebase when execution reaches them.
> This document is the living source of truth -- task elaboration for later
> phases is written back into it during execution.

**Goal:** Build an automated experiment harness that measures whether Rigor's gate enforcement improves code quality across 3 models (Gemma 4 E4B, Qwen3 8B, DeepSeek Chat) in 2 conditions (with/without Rigor), producing a deterministic scorecard comparison.

**Architecture:** A shell-based orchestrator creates isolated git worktrees per run, invokes OpenCode CLI (`opencode run --auto`) with model-specific prompts, then grades each result with a deterministic 10-point scorecard. A TypeScript report aggregator reads scorecard JSON outputs and generates a markdown comparison table. Ollama models run sequentially (GPU constraint); DeepSeek runs in parallel with an Ollama model.

**Tech Stack:** Bash (orchestrator + scorecard), TypeScript/Node.js (report aggregator), OpenCode CLI, Git worktrees, Vitest (for the cycle_history feature spec)

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | Prompts written, scorecard tested against synthetic fixtures | 1.1, 1.2 | Done |
| 2 | Full orchestrator runs 6 experiments end-to-end, report generated | 2.1, 2.2 | Done |

---

## Phase 1: Prompts & Scorecard

The foundation: what we ask models to build, and how we measure the result. Both are independently testable without running any model.

---

### Epic 1.1: Experiment Prompts

**Goal:** Three prompt files exist that fully specify the cycle_history task for both conditions, plus a pre-written plan for gated runs.
**Scope:** `scripts/experiment/prompts/`
**Dependencies:** none
**Done when:** Both prompts contain identical feature requirements; the with-rigor prompt references `/rigor-cycle` and includes a plan; the without-rigor prompt gives equivalent instructions without gate enforcement; plan.md follows the rolling-wave format from `docs/plans/`.
**Status:** Pending

#### Task 1.1.1: Write the cycle_history feature specification block

- [ ] Done

**Context:** The experiment tests whether models can build a `cycle_history` MCP tool. Both prompts need an identical feature specification block describing what to build. The tool should list completed cycles from `.rigor/history/`, return metadata (plan name, start/end time, phase count, task count, pass/fail counts), and support an optional `limit` parameter. The implementation must follow existing patterns: tool registration via `registerXTools()` in `src/tools/index.ts:1-49`, handler functions returning `CallToolResult` with `textResult()` helper as seen in `src/tools/cycle.ts:22-27`, Zod schemas for params, and tests in `src/tools/__tests__/` using vitest with `mkdtempSync` isolation as in `src/tools/__tests__/cycle.test.ts`.

**Implementation vision:** Write a shared feature spec block as a standalone section that both prompts will include verbatim. The spec must reference concrete existing patterns by file path so models can follow them: `src/tools/cycle.ts` for registration pattern, `src/tools/__tests__/cycle.test.ts` for test pattern, `src/state/schema.ts` for the CycleState interface (lines 101-108), and `src/server.ts:66-71` for where registration calls go. The spec should describe the `.rigor/history/` directory structure -- each completed cycle is a JSON file with the same shape as `CycleState` from `src/state/schema.ts`. Edge cases to name: empty history directory, missing history directory, malformed JSON files (skip gracefully), limit=0 meaning no limit.

**Files:**
- Create: `scripts/experiment/prompts/feature-spec.md` (shared block, included by both prompts)

**Verification:** Read the file; confirm it names all 4 existing pattern files, specifies the CycleState shape, lists all 4 edge cases, and describes the `limit` parameter behavior.

**Done when:** Feature spec is complete, self-contained, and references existing codebase patterns by exact path.

---

#### Task 1.1.2: Write the with-rigor prompt

- [ ] Done

**Context:** This prompt is used for gated runs. The model receives the feature spec, a pre-written plan, and instructions to use `/rigor-cycle` (the Rigor MCP slash command) to drive implementation through gates. The Rigor MCP server will be configured in the worktree, enforcing Gate 0 (tests, coverage, lint). OpenCode invocation: `opencode run --model <model> --dir <worktree> --auto "<prompt>"`.

**Implementation vision:** The prompt should: (1) include the feature spec from `feature-spec.md` inline or by reference, (2) instruct the model to use `/rigor-cycle` to initialize a cycle from the provided plan, (3) tell it to implement tasks in order, using `task_start` and `task_complete` for each, (4) reference the plan file path (`scripts/experiment/prompts/plan.md`). The prompt must NOT include hints about implementation details beyond what the plan provides -- the gate enforcement is the variable being tested, not extra guidance. Keep the prompt under 2000 tokens to fit in small model context windows alongside the plan.

**Files:**
- Create: `scripts/experiment/prompts/with-rigor.md`

**Verification:** Confirm the prompt references `/rigor-cycle`, includes the feature spec, points to plan.md, and is under 2000 tokens (rough word count < 1500).

**Done when:** Prompt is ready for use with `opencode run --auto`.

---

#### Task 1.1.3: Write the without-rigor prompt

- [ ] Done

**Context:** This prompt is used for ungated runs. Same feature, no Rigor enforcement. The model gets the feature spec and instructions to write the tool with tests, make it build, and pass lint. No MCP server, no gates, no plan.

**Implementation vision:** Include the same feature spec from `feature-spec.md`. Add instructions to: implement the tool following existing patterns in `src/tools/`, write tests, ensure `npm run build` passes, ensure `npm test` passes, ensure lint passes. The prompt should be roughly the same length as the with-rigor prompt to avoid giving one condition more context than the other. Do NOT include the plan or any structured workflow -- the point is to test what happens without gate enforcement.

**Files:**
- Create: `scripts/experiment/prompts/without-rigor.md`

**Verification:** Confirm the prompt includes the feature spec, mentions build/test/lint, does NOT reference Rigor or gates, and is roughly similar length to with-rigor.md.

**Done when:** Prompt provides equivalent task information without any gate enforcement mechanism.

---

#### Task 1.1.4: Write the pre-written plan for gated runs

- [ ] Done

**Context:** Gated runs need a plan.md that Rigor's cycle system can consume. The plan format follows the rolling-wave structure used throughout Rigor's planning skills. `cycle_init` in `src/tools/cycle.ts:69-110` reads a plan file and parses it to create the initial cycle state. The plan parser is at `src/plan/parser.ts`.

**Implementation vision:** Write a single-phase plan for the cycle_history tool with 3-4 tasks: (1) create the history reader module that loads JSON files from `.rigor/history/`, (2) create the cycle_history tool handler and registration, (3) write tests, (4) wire up registration in server.ts. Each task should follow the plan format the parser expects -- the parser looks for `#### Task N.M.T:` headings, `- [ ] Done` checkboxes, and `**Done when:**` fields. Keep the plan realistic but not overly prescriptive -- it should guide without hand-holding. Reference the same codebase files as the feature spec.

**Files:**
- Create: `scripts/experiment/prompts/plan.md`

**Verification:** Confirm the plan has proper `#### Task` headings, `- [ ] Done` checkboxes, and `**Done when:**` fields. Verify the plan parser can parse it by checking structure against `src/plan/parser.ts` expectations.

**Done when:** Plan is parseable by Rigor's cycle system and covers the cycle_history implementation end-to-end.

---

### Epic 1.2: Deterministic Scorecard

**Goal:** A shell script grades any worktree against 10 binary checks and outputs a JSON result file.
**Scope:** `scripts/experiment/scorecard.sh`, `scripts/experiment/fixtures/`
**Dependencies:** none
**Done when:** Running `scorecard.sh <path-to-worktree>` against a synthetic "perfect" fixture scores 9/10 (coverage check cannot be faked without vitest installed); running against an empty fixture scores 0-1/10; output is valid JSON with all 10 check names, scores, and a total.
**Status:** Pending

#### Task 1.2.1: Implement the scorecard script

- [ ] Done

**Context:** The scorecard grades model output using 10 binary checks defined in the design doc (`docs/designs/2026-07-20-quality-experiment.md:89-102`). Each check is worth 1 point, for a 10-point max. The script receives a worktree path as its argument and writes JSON to stdout or a specified output path.

**Implementation vision:** Bash script with 10 check functions, each returning 0 (pass) or 1 (fail). Checks in order:

1. **Builds**: Run `npm run build` in the worktree, check exit code.
2. **Test file exists**: Glob for `**/cycle-history*.test.ts` or `**/history*.test.ts` in `src/`.
3. **Tests pass**: Run `npm test` in the worktree, check exit code.
4. **Coverage >= 85%**: Run vitest with coverage, parse the text output for the total percentage. If coverage tooling is not configured in the worktree, this check fails (score 0).
5. **Lint clean**: Run the lint command (detect from package.json scripts or fall back to `npx tsc --noEmit`), check exit code.
6. **Tool registers in server**: Grep for `cycle_history` in `src/server.ts` or `src/tools/index.ts`.
7. **Handler follows pattern**: Grep for `CallToolResult` return type in the new tool file, and for `textResult` usage.
8. **Tests follow pattern**: Grep for `describe(` and `it(` in the test file.
9. **Reads from .rigor/history/**: Grep for `history` path usage in source files under `src/tools/`.
10. **Edge case handling**: Grep for empty/missing directory handling (look for `existsSync`, `mkdirSync`, or try/catch around readdir).

Output JSON shape:
```json
{
  "model": "<from arg or env>",
  "condition": "<from arg or env>",
  "checks": {
    "builds": 0,
    "test_file_exists": 1,
    ...
  },
  "total": 7,
  "max": 10,
  "timestamp": "2026-07-20T..."
}
```

The script must `cd` into the worktree, run commands there, and not modify the worktree (read-only grading). Accept `--model` and `--condition` flags to tag the output, plus `--output` for the JSON file path (default: stdout).

**Files:**
- Create: `scripts/experiment/scorecard.sh`

**Verification:** Run `bash scripts/experiment/scorecard.sh --help` to confirm it accepts the expected flags. Test against the current repo root (which has no cycle_history) -- should score low but not crash.

**Done when:** Script runs all 10 checks, outputs valid JSON, handles missing files gracefully (scores 0, does not crash).

---

#### Task 1.2.2: Create test fixtures for scorecard validation

- [ ] Done

**Context:** The scorecard needs to be validated before we trust it for the experiment. We need at least two fixtures: a "perfect" implementation that should score 10/10, and an "empty" baseline that scores near 0. These fixtures are minimal directory trees, not full repos -- just enough structure for the scorecard checks to exercise.

**Implementation vision:** Create two fixture directories under `scripts/experiment/fixtures/`:

**`fixtures/perfect/`**: A minimal tree that passes all 10 checks. Contains a `package.json` with build/test scripts, a `src/tools/history.ts` file with `CallToolResult`, `textResult`, `cycle_history` registration, and `.rigor/history/` path usage, a `src/tools/__tests__/history.test.ts` with `describe`/`it` blocks, and a `src/server.ts` or `src/tools/index.ts` with `cycle_history` reference. The code does not need to actually run -- the scorecard uses grep checks for most criteria. For the build/test/lint/coverage checks (1-5), the fixture's package.json scripts can be simple `exit 0` stubs.

**`fixtures/empty/`**: A bare `package.json` with failing scripts (`exit 1`). No tool files, no tests. Should score 0/10.

**Files:**
- Create: `scripts/experiment/fixtures/perfect/package.json`
- Create: `scripts/experiment/fixtures/perfect/src/tools/history.ts`
- Create: `scripts/experiment/fixtures/perfect/src/tools/__tests__/history.test.ts`
- Create: `scripts/experiment/fixtures/perfect/src/tools/index.ts`
- Create: `scripts/experiment/fixtures/empty/package.json`

**Verification:** Run `bash scripts/experiment/scorecard.sh scripts/experiment/fixtures/perfect` and confirm 10/10. Run against `fixtures/empty` and confirm 0/10.

**Done when:** Both fixtures produce the expected scores, validating that the scorecard works correctly.

---

## Phase 2: Orchestrator & Report

---

### Epic 2.1: Experiment Orchestrator

**Goal:** `run.sh` executes the full 6-run experiment matrix (3 models x 2 conditions) with proper isolation, execution ordering, and error handling.
**Scope:** `scripts/experiment/run.sh`, worktree management
**Dependencies:** Epic 1.1 (prompts), Epic 1.2 (scorecard)
**Done when:** Running `run.sh` creates 6 worktrees, invokes OpenCode with correct model/prompt/config per run, respects Ollama sequential constraint, runs scorecard after each completion, and collects 6 result JSON files in `scripts/experiment/results/`. A `--dry-run` flag logs what would execute without running OpenCode.
**Status:** Pending

#### Task 2.1.1: Implement the experiment orchestrator

- [ ] Done

**Context:** The design doc (`docs/designs/2026-07-20-quality-experiment.md:17-37`) defines the execution order: Ollama models run sequentially (GPU constraint), DeepSeek runs in parallel with an Ollama model. The 4 execution steps are: (1) Gemma4 with-rigor, (2) Gemma4 without-rigor + DeepSeek with-rigor in parallel, (3) Qwen3 with-rigor, (4) Qwen3 without-rigor + DeepSeek without-rigor in parallel. OpenCode CLI syntax: `opencode run --model <provider/model> --dir <worktree> --auto "prompt"`. Model identifiers: `ollama/gemma4:e4b`, `ollama/qwen3:8b`, `deepseek/deepseek-chat`. Prompts are at `scripts/experiment/prompts/with-rigor.md` and `scripts/experiment/prompts/without-rigor.md`. Scorecard is at `scripts/experiment/scorecard.sh`.

**Implementation vision:** Bash script with these phases:

1. **Setup**: Define the 6-entry matrix as arrays (model, condition pairs). Create `scripts/experiment/results/` directory.

2. **Worktree creation**: For each of the 6 runs, create a git worktree from `main` at `worktrees/<model>-<condition>/` (relative to the repo root). The worktree path uses sanitized model names (e.g., `gemma4-with-rigor`).

3. **Config injection**: For "with-rigor" worktrees, copy `.rigor/config.yaml` into the worktree (create `.rigor/` dir first). Also ensure the OpenCode MCP server config is present so the model can use Rigor tools. For "without-rigor" worktrees, do nothing extra.

4. **Prompt loading**: Read the appropriate prompt file content. For with-rigor, read `scripts/experiment/prompts/with-rigor.md`. For without-rigor, read `scripts/experiment/prompts/without-rigor.md`. Pass prompt content to `opencode run --auto`.

5. **Execution**: Follow the 4-step execution order from the design. Use `&` and `wait` for parallel steps. For each run, invoke `opencode run --model <model> --dir <worktree> --auto "<prompt>"`. After each OpenCode exit, run `bash scripts/experiment/scorecard.sh <worktree> --model <model> --condition <condition> --output scripts/experiment/results/<model>-<condition>.json`.

6. **Completion**: After all 6 runs, print summary of result file locations.

Flags:
- `--dry-run`: Log all commands without executing OpenCode (still create worktrees and show what would run)
- `--timeout <seconds>`: Per-run timeout (default 1800 = 30 min), kills OpenCode if exceeded
- `--help`: Usage info
- `--cleanup`: Remove worktrees after scoring (default: keep for inspection)

Handle timeouts with `timeout` command wrapping the `opencode run` call. If a run times out, scorecard still runs (grades whatever partial work exists). Log start/end timestamps for each run.

**Files:**
- Create: `scripts/experiment/run.sh`

**Verification:** Run `bash scripts/experiment/run.sh --dry-run` and confirm it prints the 4 execution steps with correct model/condition/prompt combinations without actually invoking OpenCode.

**Done when:** Dry-run shows correct execution plan; script handles all 6 matrix entries with proper Ollama-sequential/DeepSeek-parallel ordering.

---

### Epic 2.2: Report Aggregator

**Goal:** `report.ts` reads all scorecard results and generates a markdown comparison table.
**Scope:** `scripts/experiment/report.ts`
**Dependencies:** Epic 2.1 (results exist in `scripts/experiment/results/`)
**Done when:** Running `npx tsx scripts/experiment/report.ts` reads JSON files from `results/`, produces a markdown table with models as rows, conditions as columns, individual check scores, and totals. Output goes to `scripts/experiment/results/report.md` and stdout.
**Status:** Pending

#### Task 2.2.1: Implement the report aggregator

- [ ] Done

**Context:** The scorecard outputs JSON files to `scripts/experiment/results/<model>-<condition>.json` with the shape defined in `scripts/experiment/scorecard.sh:12-25` (model, condition, checks object with 10 named scores, total, max, timestamp). The project uses TypeScript with `tsx` available as a runner (see `package.json` devDependencies). The existing script pattern is `scripts/token-budget.ts` which runs standalone with `npx tsx`.

**Implementation vision:** TypeScript script that:

1. **Reads results**: Glob `scripts/experiment/results/*.json`, parse each file. Skip non-JSON or malformed files gracefully.

2. **Structures data**: Group results by model. Each model has two entries (with-rigor, without-rigor). Handle missing results (if a run failed/timed out and produced no scorecard).

3. **Generates markdown table**: Format as a comparison table with:
   - Header row: Check name | Model A (with) | Model A (without) | Model B (with) | ...
   - One row per check (10 rows)
   - Total row at bottom
   - Use checkmark/cross symbols for 1/0 scores for readability
   - Include a delta column per model showing with-rigor minus without-rigor score difference

4. **Writes output**: Write to both `scripts/experiment/results/report.md` and stdout.

5. **Summary section**: After the table, add a brief summary: which model scored highest overall, whether with-rigor consistently outperformed without-rigor, and the average delta across models.

Use only Node.js built-in modules (`fs`, `path`, `process`) to avoid adding dependencies. The script should work with `npx tsx scripts/experiment/report.ts` or accept a custom results directory as an argument.

**Files:**
- Create: `scripts/experiment/report.ts`

**Verification:** Create two sample JSON files in `scripts/experiment/results/` matching the scorecard output format, run `npx tsx scripts/experiment/report.ts`, confirm the markdown table renders correctly with all checks, totals, and delta column.

**Done when:** Report generates a readable comparison table from scorecard JSON files, handles missing results, and writes to both stdout and report.md.

---

## Self-Review

| Check | Result |
|-------|--------|
| **Spec coverage** | All design doc components mapped: run.sh (2.1), scorecard.sh (1.2), report.ts (2.2), prompts (1.1), results dir (2.1). Worktree isolation covered in 2.1. Execution order covered in 2.1. |
| **Vagueness scan** | Phase 1 tasks name specific checks, file paths, JSON shapes, and edge cases. No "appropriate" or "TBD". |
| **Contract consistency** | Scorecard JSON shape defined in 1.2.1 is consumed by report.ts in 2.2. Feature spec (1.1.1) is referenced by both prompts (1.1.2, 1.1.3). Plan (1.1.4) is referenced by with-rigor prompt (1.1.2). |
| **Phase boundaries** | Phase 1 ends with tested prompts and a validated scorecard. Phase 2 ends with a full experiment run and report. Both independently verifiable. |
| **Verification plausibility** | Phase 1 verifications use `bash scorecard.sh` against fixtures -- runnable without models. |
