# The Hybrid Approach

## Core Principle

> If you can write an `if` statement for it, don't ask an LLM.

This principle drives every design decision in Rigor. It produces a clean
separation:

| Deterministic (code) | AI (agents) |
|---|---|
| Did tests pass? | Is the code correct? |
| Is coverage >= 85%? | Is the architecture sound? |
| Does lint pass? | Are there logic bugs? |
| Do migration files parse? | Is error handling sufficient? |
| Are all reviewers accounted for? | What do the reviewers think? |
| Did the user approve? | What should be in the report? |
| Which gate comes next? | What code should be written? |

## Why Pure Prompt Fails at Scale

Prompt-only orchestration (Ring's approach) works surprisingly well — until
it doesn't. The failure modes are:

1. **Context drift** — in long sessions, the LLM gradually loses track of
   gate requirements buried thousands of tokens back
2. **Hallucinated compliance** — "I've verified coverage is at 87%" when it
   never ran the command
3. **Silent gate skips** — the LLM proceeds to the next gate without
   completing the current one, especially under time pressure from the user
4. **State corruption** — the LLM writes malformed JSON to the state file,
   breaking cycle resume
5. **Model regression** — a model update changes how strictly instructions
   are followed

These aren't theoretical — they're observed failure modes in production
prompt-based orchestration systems.

## Why Pure Code Fails for Dev Workflows

Traditional CI handles the deterministic side perfectly but can't:

1. **Write code** — the creative work inside Gate 0
2. **Judge quality** — "is this error handling sufficient?" has no exit code
3. **Understand context** — "does this change align with the PRD?"
4. **Provide nuanced review** — security analysis, architectural judgment
5. **Interact conversationally** — "this approach has a race condition, here's why"

## The Hybrid: Each Layer Does What It's Best At

```
Development Cycle Flow
══════════════════════

Phase 1, Epic 1.1, Task 1.1.1
│
├─ Gate 0: Implementation
│  ├─ [CODE] Check entry criteria (state machine)
│  ├─ [AI]   Write failing test (TDD RED)
│  ├─ [AI]   Write code to pass (TDD GREEN)
│  ├─ [AI]   Refactor
│  ├─ [CODE] Run tests → exit code
│  ├─ [CODE] Parse coverage → compare to threshold
│  ├─ [CODE] Run linter → exit code
│  └─ [CODE] Advance state machine if all pass
│
├─ Gate 8: Review (after all tasks in epic)
│  ├─ [CODE] Check all tasks passed Gate 0
│  ├─ [CODE] Compute epic diff (git)
│  ├─ [AI]   Dispatch parallel reviewers
│  ├─ [AI]   Each reviewer analyzes diff
│  ├─ [CODE] Validate all reviewers reported
│  ├─ [CODE] Check zero critical findings
│  └─ [CODE] Advance state machine if all pass
│
├─ Gate 9: Acceptance
│  ├─ [CODE] Check Gate 8 passed
│  ├─ [AI]   Map criteria to evidence
│  ├─ [CODE] Validate all criteria mapped
│  ├─ [CODE] Prompt user for approval
│  └─ [CODE] Advance state machine on approval
│
└─ Phase Boundary
   ├─ [CODE] Check all epics passed Gate 9
   ├─ [AI]   Elaborate next phase (rolling-wave)
   ├─ [CODE] Validate next phase has tasks
   └─ [CODE] Update phase states
```

## Implementation: MCP Server

The deterministic layer runs as an MCP server — a process that the AI
assistant connects to via the standard Model Context Protocol.

**Why MCP over alternatives:**

| Option | Pros | Cons |
|---|---|---|
| **MCP server** | Universal (works in Claude Code, OpenCode, Cursor), conversational UX preserved, agent calls tools naturally | Requires running a process |
| **CLI orchestrator** | Full control, batch processing | Loses conversational flow, each agent session is isolated |
| **Hooks only** | Simple, no separate process | Can only block/allow — can't orchestrate or manage state |
| **Custom plugin per provider** | Deep integration | Must maintain N implementations |

MCP is the right choice because:
1. It's the emerging standard across all major coding assistants
2. The agent interacts with gate tools the same way it interacts with any
   other tool — naturally, within the conversation
3. The server enforces rules the agent can't bypass — it simply won't
   return next-gate instructions until criteria pass
4. Same server works across Claude Code, OpenCode, Cursor, etc.

## What This Means in Practice

**Ring today:**
```
Agent reads SKILL.md → SKILL.md says "check coverage >= 85%" →
Agent may or may not actually run the command →
Agent may or may not parse the output correctly →
Agent writes to state.json (may write it wrong) →
Agent proceeds to next gate (may skip if context is long)
```

**Rigor:**
```
Agent calls gate.check_exit("gate_0") →
Server runs `go test -coverprofile` itself →
Server parses coverage output itself →
Server returns { passed: false, coverage: 72, threshold: 85 } →
Agent literally cannot get next gate instructions until server says PASS →
Server writes state (agent never touches state file)
```

The agent does the creative work. The server does the bookkeeping.
