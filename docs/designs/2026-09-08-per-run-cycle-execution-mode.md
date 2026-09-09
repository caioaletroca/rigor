# Per-Run Cycle Execution Mode -- Design Document

> **Status:** Approved
> **Date:** 2026-09-08
> **Exploration:** 3 alternatives evaluated

## Context

The `rigor:cycle` skill currently provides lifecycle instructions but does not establish whether execution should pause after ordinary milestones. This can cause unnecessary confirmation prompts even though Gate 9 is the configured human-approval boundary.

## Architecture

`rigor:cycle` asks for a session-scoped execution mode before it begins lifecycle work. The choice affects agent orchestration only; it does not change MCP gate semantics, cycle state, evidence, or recovery behavior.

## Components

| Component | Type | Purpose |
|---|---|---|
| `skills/cycle/SKILL.md` | Modify | Define mode selection, continuous execution behavior, and stop conditions. |
| Cycle documentation | Modify | Explain Stepwise and Continuous modes to users. |

## Data Flow

1. A user invokes `rigor:cycle` to execute a plan or active cycle.
2. The skill asks the user to choose Stepwise or Continuous mode before cycle work begins.
3. Stepwise mode reports after ordinary gates and waits for user continuation.
4. Continuous mode continues task execution, Gate 0 retries, review, acceptance setup, and phase advancement without ordinary confirmation prompts.
5. On Gate 9, the skill presents criteria and requires actual user approval when the configured gate requires it.
6. Continuous mode also stops for ambiguous requirements, a rolling-wave phase without elaborated tasks, unrecoverable gate failure, or explicit user interruption.

## Key Decisions

| Decision | Chosen | Rejected Alternative | Why |
|---|---|---|---|
| User interface | Startup mode prompt in `rigor:cycle` | Separate auto command | Keeps one discoverable command and selects behavior per run. |
| Mode persistence | Session-scoped instruction state | Store mode in cycle state | MCP tools cannot perform implementation/review autonomously; persistence adds no enforcement value. |
| Approval boundary | Gate 9 remains human-approved | Auto-approve Gate 9 in continuous mode | Preserves configured acceptance controls. |
| Ordinary gate behavior | Continue automatically in Continuous mode | Require confirmation after every gate | Removes the workflow interruption that motivated the change. |
| Exceptional states | Stop and report blockers | Continue blindly | Ambiguity and unrecoverable failures require human direction. |

## Open Questions

None.

## Alternatives Considered

- **Separate `rigor:cycle-auto` skill:** keeps each instruction set short but duplicates lifecycle content and creates a second command.
- **Server-side mode:** could survive reconnects but cannot automate the agent work between MCP gates and adds unnecessary state complexity.
