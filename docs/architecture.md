# Architecture

## Two-Layer Design

Rigor has two layers that interact at well-defined integration points:

```
┌─────────────────────────────────────────────────┐
│  AI Agent (Claude Code / OpenCode / Cursor)      │
│  - Writes code, reviews, tests                   │
│  - Applies judgment and creativity               │
│  - MUST call Rigor tools to advance gates        │
│  - Cannot skip or self-certify gate passage      │
└──────────────┬──────────────────────────────────┘
               │ MCP protocol
┌──────────────▼──────────────────────────────────┐
│  Rigor Gate Server                               │
│  - Deterministic state machine (real code)       │
│  - Validates entry/exit criteria programmatically│
│  - Persists state to file/DB                     │
│  - REFUSES to advance if criteria aren't met     │
│  - Emits CI-compatible artifacts                 │
└─────────────────────────────────────────────────┘
```

## Why MCP

MCP (Model Context Protocol) is supported natively by Claude Code, OpenCode,
Cursor, and other AI coding assistants. By implementing the gate server as an
MCP server, Rigor:

- Works inside the assistant's session (conversational UX preserved)
- Enforces gates deterministically (the server controls tool responses)
- Is portable across assistants without per-provider plugins
- Can also run standalone as a CLI for CI pipelines

## Gate Server Responsibilities

The gate server is the **only** component that:

1. **Tracks state** — which phase, epic, task, and gate the cycle is at
2. **Validates transitions** — checks entry criteria before allowing a gate
3. **Verifies exit criteria** — runs deterministic checks (coverage, lint, tests)
4. **Advances the state machine** — moves to the next gate only on PASS
5. **Emits evidence** — structured JSON artifacts proving each gate passed

The AI agent **cannot**:
- Self-report gate passage ("I checked coverage and it's fine")
- Skip gates or reorder them
- Modify state directly

## AI Agent Responsibilities

The AI agent handles everything requiring **judgment or creativity**:

- Writing code (Gate 0 — implementation)
- Writing tests (Gate 0 — TDD)
- Reviewing code for logic, security, architecture (Gate 8 — review)
- Suggesting remediations for review findings
- Generating reports

## Integration Points

### Gate 0: Implementation

```
Agent: gate.start_task("1.1.1")
Server: { gate: 0, task: "1.1.1", status: "in_progress" }

  ... agent writes code and tests ...

Agent: gate.check_exit("gate_0")
Server: runs `go test -coverprofile`, checks threshold
Server: { passed: false, coverage: 72.3, threshold: 85, missing: [...] }

  ... agent writes more tests ...

Agent: gate.check_exit("gate_0")
Server: { passed: true, coverage: 87.1, threshold: 85 }
Server: auto-advances to next task or gate
```

### Gate 8: Review

```
Agent: gate.start_review("epic_1.1")
Server: { gate: 8, epic: "1.1", diff: "abc123..def456" }

  ... agent dispatches reviewer subagents ...
  ... reviewers analyze diff and return findings ...

Agent: gate.submit_review({ findings: [...], passed: true })
Server: validates all required reviewers reported
Server: { passed: true, all_reviewers_reported: true }
```

### Gate 9: Acceptance

```
Agent: gate.start_validation("epic_1.1")
Server: { gate: 9, criteria: [...], evidence_required: true }

  ... agent maps criteria to evidence ...

Agent: gate.submit_validation({ criteria_map: [...] })
Server: checks all criteria have evidence
Server: prompts user for approval (or returns approval_required: true)
```

## Hooks Layer (Guardrails)

Optional hooks provide guardrails on top of the gate system:

- **PreToolUse (Write/Edit)**: Block writes to files outside current task scope
- **PostToolUse (Bash)**: Auto-record test results in gate state
- **PreToolUse (Bash)**: Block destructive commands during active gate

These are supplementary — the MCP server is the primary enforcement mechanism.

## State Persistence

Gate state is persisted as a JSON file after every transition:

```
.rigor/
  state.json          # Current cycle state
  evidence/           # Gate passage artifacts
    gate-0-task-1.1.1.json
    gate-8-epic-1.1.json
    gate-9-epic-1.1.json
  history/            # Completed cycles
```

The state file is the source of truth. If the AI session crashes, the cycle
resumes from the last persisted state.
