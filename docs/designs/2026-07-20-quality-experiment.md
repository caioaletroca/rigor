# Rigor Quality Experiment Harness -- Design Document

> **Status:** Approved
> **Date:** 2026-07-20
> **Exploration:** 3 alternatives evaluated

## Context

Rigor enforces quality gates deterministically, but we have no empirical evidence that this actually improves code quality vs prompting alone. We also don't know if cheaper/smaller models can produce acceptable results when gates compensate for weaker reasoning. This experiment answers both questions with measurable data.

## Architecture

A shell script orchestrates the full experiment matrix: 3 models x 2 conditions = 6 runs. For each run, it creates an isolated git worktree, configures the environment, invokes OpenCode in CLI mode (`opencode run`) with the right model and prompt, waits for completion, then runs a deterministic scorecard against the result. A final report aggregates all scores into a comparison table.

### Execution Order

Ollama models (Gemma 4 E4B, Qwen3 8B) run sequentially due to local GPU constraints. DeepSeek Chat (remote API) can run in parallel with an Ollama model.

Planned order:
1. Gemma 4 with-rigor
2. Gemma 4 without-rigor + DeepSeek with-rigor (parallel)
3. Qwen3 with-rigor
4. Qwen3 without-rigor + DeepSeek without-rigor (parallel)

### OpenCode CLI Syntax

```bash
# Non-interactive run with model override
opencode run --model <provider/model> --dir <worktree-path> --auto "prompt text"

# Model identifiers (from opencode.json):
#   ollama/gemma4:e4b
#   ollama/qwen3:8b
#   deepseek/deepseek-chat

# --auto flag auto-approves tool permissions (needed for MCP tools)
```

## The Test Task

Build a `cycle_history` MCP tool for Rigor that:
- Lists completed cycles from `.rigor/history/`
- Returns cycle metadata (plan name, start/end time, phase count, task count, pass/fail counts)
- Supports an optional `limit` parameter
- Includes tests following the existing pattern in `src/tools/__tests__/`

This is a real gap in Rigor. It touches the existing tool registration pattern (`src/tools/`), state schema (`src/state/`), and file I/O. Complex enough to differentiate quality, small enough to finish in one session.

## Components

| Component | Type | Purpose |
|-----------|------|---------|
| `scripts/experiment/run.sh` | new | Main orchestrator script |
| `scripts/experiment/scorecard.sh` | new | Post-run grading script |
| `scripts/experiment/report.ts` | new | Aggregate results into markdown |
| `scripts/experiment/prompts/with-rigor.md` | new | Task prompt for gated runs |
| `scripts/experiment/prompts/without-rigor.md` | new | Task prompt for ungated runs |
| `scripts/experiment/prompts/plan.md` | new | Pre-written plan for gated runs |
| `scripts/experiment/results/` | new (dir) | Per-run scorecard JSON outputs |

## Data Flow

1. `run.sh` reads the model/condition matrix (6 entries)
2. For each combination, creates a git worktree from the `main` branch
3. For "with rigor" runs: copies `.rigor/config.yaml` and MCP server config into the worktree, prompt references `/rigor-cycle` and provides a plan
4. For "without rigor" runs: no `.rigor/`, no MCP server config, prompt is the raw feature spec with instructions to write tests and pass lint
5. Invokes: `opencode run --model <model> --dir <worktree> --auto "<prompt>"`
6. After OpenCode exits, runs `scorecard.sh <worktree>` to grade the output
7. Scorecard writes results to `scripts/experiment/results/<model>-<condition>.json`
8. After all 6 runs complete, `report.ts` reads result files and generates a comparison markdown table

## Worktree Isolation

Each run gets a fresh worktree branched from main:

```
worktrees/
  gemma4-with-rigor/
  gemma4-without-rigor/
  qwen3-with-rigor/
  qwen3-without-rigor/
  deepseek-with-rigor/
  deepseek-without-rigor/
```

Worktrees are independent. One model's output cannot contaminate another's. After the experiment, worktrees can be inspected or deleted.

## Scorecard Criteria (10 points max)

| Check | Points | Method |
|-------|--------|--------|
| Builds (`tsc` compiles) | 1 | `npm run build` exit code |
| Test file exists | 1 | Glob for `**/cycle-history*.test.ts` or `**/history*.test.ts` |
| Tests pass | 1 | `npm test` exit code |
| Coverage >= 85% | 1 | Parse coverage output from vitest |
| Lint clean | 1 | Lint command exit code |
| Tool registers in server | 1 | Grep for `cycle_history` in `src/` |
| Handler follows pattern | 1 | Check for `CallToolResult` return type, `textResult` helper |
| Tests follow pattern | 1 | Check for vitest `describe`/`it` blocks |
| Reads from `.rigor/history/` | 1 | Grep for history path usage in source |
| Edge case handling | 1 | Check for empty/missing directory handling |

Each check is binary (0 or 1). Total score is the sum. No subjective grading.

## Prompt Design

Both prompts describe the same `cycle_history` feature specification. The difference is enforcement:

**with-rigor prompt:** Includes the feature spec, a pre-written plan.md, and instructs the model to use `/rigor-cycle` to drive the implementation through gates. The MCP server is configured and enforces Gate 0 (tests, coverage, lint).

**without-rigor prompt:** Includes the same feature spec and instructs the model to implement it with tests, make sure it builds, and passes lint. No plan, no gates, just good instructions.

Both prompts include identical feature requirements so the task is the same. The only variable is the enforcement mechanism.

## Key Decisions

| Decision | Chosen | Rejected | Why |
|----------|--------|----------|-----|
| Task | cycle_history (real feature) | Synthetic todo app | Real feature tests pattern adherence in existing codebase |
| Isolation | Git worktrees | Separate clones | Worktrees share .git, faster to create, built-in git support |
| Scoring | Deterministic shell checks | AI-based review | Reproducible, no scoring model bias, cheaper |
| Prompt parity | Same feature spec in both | Different detail levels | Fair comparison requires identical task, only enforcement differs |
| Runner | Shell script | TypeScript harness | Simpler, shell is natural for CLI orchestration |
| Execution | Sequential Ollama, parallel DeepSeek | All parallel | Local GPU cannot run two Ollama models simultaneously |
| CLI mode | `opencode run --auto` | Interactive TUI | Automated, no human intervention needed |

## Open Questions

- Whether Ollama local models can handle the full task in one pass or will hit context/reasoning limits partway through
- Exact timeout to set per run (30 min? 60 min?) before killing a stuck model
- Whether `opencode run` exits cleanly when the model considers itself done, or if it needs explicit termination

## Alternatives Considered

### Option B: Direct API Harness

Build a TypeScript harness that calls model APIs directly and implements MCP client logic. Rejected because it's significantly more effort (need to build an MCP client), doesn't test the real user workflow, and different models handle tool calling differently via raw API.

### Option C: Semi-Manual with Automated Setup/Grading

Automate worktree creation, config setup, and scorecard grading, but trigger each OpenCode run manually. Rejected because the user wants full automation. The setup/grading automation is incorporated into Option A regardless.
