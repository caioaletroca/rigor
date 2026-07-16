# Why Rigor

## The Problem

AI coding assistants (Claude Code, OpenCode, Cursor, etc.) are powerful but
have no built-in concept of **quality gates** — structured checkpoints that
code must pass before progressing through a development workflow.

Teams solve this today in two ways, both with significant tradeoffs:

### 1. Pure Prompt Orchestration (Ring's approach)

Systems like [Ring](https://github.com/LerianStudio/ring) build an entire
dev-cycle state machine using only SKILL.md files and natural language
instructions. The LLM is told "do not proceed until coverage >= 85%" and
trusted to obey.

**Strengths:**
- Zero infrastructure — just markdown files
- Portable across Claude Code, OpenCode, Cursor, etc.
- Rich orchestration (multi-agent, rolling-wave phases, parallel reviews)
- No separate runtime needed

**Weaknesses:**
- **Fragile** — the LLM can skip gates if context drifts, instructions are
  long, or the model regresses
- **No deterministic verification** — "check coverage" is a prompt, not code
- **Unauditable** — no CI artifact proves a gate actually passed
- **State managed by prompts** — JSON file written/read by the LLM itself

### 2. Traditional CI/CD (GitHub Actions, Jenkins, etc.)

Deterministic pipelines that run linters, tests, and checks on every push.

**Strengths:**
- Fully deterministic and auditable
- Battle-tested infrastructure
- Clear pass/fail signals

**Weaknesses:**
- Can't do AI-powered work (code review with reasoning, architectural
  judgment, design critique)
- No in-session workflow — runs after push, not during development
- No concept of "implementation gates" or dev-cycle phases

## The Insight

[Impeccable](https://github.com/pbakaus/impeccable) demonstrated a hybrid
approach in the design quality space:

- **46 deterministic rules** as real JavaScript functions — no LLM needed
- **23 AI-powered commands** for judgment that rules can't express
- The `/audit` command runs deterministic checks first, then layers AI
  critique on top

**The principle: if you can write an `if` statement for it, don't ask an LLM.**

## Rigor's Position

Rigor applies the Impeccable-style hybrid to the **full development lifecycle**:

```
Deterministic layer (code)     AI layer (agents/skills)
─────────────────────────      ───────────────────────────
Coverage >= threshold?         Is the architecture sound?
Lint passing?                  Are there logic bugs?
Tests exist for new code?      Is the error handling sufficient?
Docker config present?         Does the design match the spec?
Migrations valid?              Is the code idiomatic?
State machine transitions      Creative work (implementation)
Gate entry/exit criteria       Code review judgment
```

Neither layer alone is sufficient. Deterministic checks catch objective
failures; AI applies subjective expertise. Rigor orchestrates both.
