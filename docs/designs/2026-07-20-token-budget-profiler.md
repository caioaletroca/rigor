# Token Budget Profiler -- Design Document

> **Status:** Approved
> **Date:** 2026-07-20
> **Exploration:** 3 alternatives evaluated

## Context

Rigor's skills and agents consume context window space. Cheap models often have smaller windows (8k-32k). Before running quality experiments across model tiers, we need to know which models can physically fit Rigor's prompts. This profiler answers: "what is Rigor's token footprint, and which context windows can support it?"

## Architecture

A standalone TypeScript script that reads Rigor's skill, agent, and MCP tool definition files, counts tokens, and produces a compatibility matrix against common context windows. No runtime dependencies on the MCP server. Lives in `scripts/`.

## Components

| Component | Type | Purpose |
|-----------|------|---------|
| `scripts/token-budget.ts` | new | Main profiler script |
| stdout / optional file | output | Markdown report with compatibility matrix |

## What It Measures

### Layer 1: Skill Prompts

For each `skills/*/SKILL.md`:
- File size in bytes
- Estimated token count
- Classification: core (cycle, commit, review, etc.) vs on-demand (brainstorm, debug, etc.)

### Layer 2: Agent Prompts

For each `agents/**/*.md`:
- File size in bytes
- Estimated token count
- Classification: core (security, logic, test, implementation, recovery, plan-writer) vs software-domain (nil, consequences, dead-code, performance, code-quality, requirements, design-quality)

### Layer 3: MCP Tool Descriptions

For each tool registered in `src/server.ts`:
- Extract the tool name and JSON schema description
- Estimate token count of the schema sent to the model
- Sum total MCP overhead

### Layer 4: Cycle Simulation

Model typical usage scenarios by summing component tokens:

- **Minimal cycle:** cycle skill + 1 implementation agent + 3 core reviewers
- **Full software cycle:** cycle skill + 1 implementation agent + 10 reviewers (core + software domain)
- **MCP baseline:** all tool descriptions (always present when server is connected)

## Token Counting

Character-based approximation: ~4 characters per token. Accurate within 10-15% across GPT, Claude, and DeepSeek tokenizers. No external dependency needed. Real tokenizers vary by model anyway, so exact counts would be false precision.

## Output: Context Window Compatibility Matrix

The report maps Rigor components against common context windows:

```
| Component              | Tokens | 8k  | 16k | 32k  | 128k | 200k |
|------------------------|--------|-----|-----|------|------|------|
| cycle skill            | ~X     | ... | ... | ...  | ...  | ...  |
| implementation agent   | ~X     | ... | ... | ...  | ...  | ...  |
| security-reviewer      | ~X     | ... | ... | ...  | ...  | ...  |
| ...                    |        |     |     |      |      |      |
| MCP tool schemas       | ~X     | ... | ... | ...  | ...  | ...  |
| TOTAL (minimal cycle)  | ~X     | NO  | NO  | YES  | YES  | YES  |
| TOTAL (full review)    | ~X     | NO  | NO  | TIGHT| YES  | YES  |
```

Each cell shows: `YES` (fits with 50%+ free for conversation), `TIGHT` (fits with 25-50% free), `NO` (does not fit or <25% free).

The 50% threshold exists because the model needs working space for: the user's code, tool call results (test output, lint output, diffs), and its own reasoning.

## Data Flow

1. Script globs `skills/*/SKILL.md` and `agents/**/*.md`
2. Reads each file, counts characters, divides by 4
3. Parses `src/server.ts` for tool registrations, estimates schema token cost
4. Builds component inventory with classifications
5. Sums scenario totals (minimal, full)
6. Maps against context window tiers [8k, 16k, 32k, 128k, 200k]
7. Writes markdown report to stdout

## Key Decisions

| Decision | Chosen | Rejected | Why |
|----------|--------|----------|-----|
| Token counting | Char-based (~4 chars/token) | tiktoken dependency | Zero deps, good enough for profiling |
| Language | TypeScript | Bash/Python | Same stack as Rigor |
| Output | Markdown to stdout | JSON | Human-readable, pipeable to file |
| Scope | Static file analysis | Runtime measurement | Deterministic, fast, reproducible |
| MCP tool descriptions | Included | Excluded | Always present when server is connected, part of baseline budget |

## Open Questions

- After profiling, if cheap models are context-viable, the next step is the quality experiment (Option B/C Part 2 from brainstorm). That is a separate design.

## Alternatives Considered

### Option A: Controlled Task Benchmark (without profiling)

Run fixed coding tasks across a {Rigor on/off} x {model tier} matrix. Rejected because it doesn't answer the context window question first, risking wasted experiment time on models that physically can't fit Rigor.

### Option B: Full Cycle on a Real Feature

Run a full Rigor cycle per model tier on a real feature. Rejected for v0 because it's slow, hard to control, and doesn't isolate the context variable. Planned as the follow-up experiment after profiling identifies viable models.
