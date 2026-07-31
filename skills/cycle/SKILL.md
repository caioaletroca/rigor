---
name: rigor:cycle
description: >-
  Drive a full development cycle through the Rigor MCP gate server:
  init from a plan, start/complete tasks with Gate 0 enforcement,
  submit reviews (Gate 8), accept epics (Gate 9), and advance phases.
  Use when the user asks to "run the cycle", "start dev cycle", or
  "execute the plan". Skip when no plan.md exists or the user wants
  to work outside the gate system.
---

Execute a phased development cycle controlled by the Rigor MCP gate server. The server enforces deterministic quality gates -- you cannot self-certify passage. Every gate transition requires evidence produced by the server's shell execution, not your own judgment.

---

## HARD STOP -- UNDERSTAND THE RULES

1. **You never edit `.rigor/state.json` or `.rigor/evidence/` files directly.** All state changes go through MCP tools.
2. **You never fabricate evidence.** If a gate fails, fix the underlying issue and retry. Do not invent passing results.
3. **You never skip a gate.** Every task passes Gate 0. Every epic passes Gates 8 and 9. Every phase passes all epics before advancing.
4. **You never call `task_complete` without implementing.** The server runs real tests/lint -- empty implementations fail.

---

## Lifecycle Sequence

```
cycle_init(plan_path)
  |
  v
for each task in phase:
  task_start(task_id)    -- Gate entry: validates order, custom pre_task gates, Gate 1
    |
    v
  [implement the task]
    |
    v
  task_complete(task_id) -- Gate 0: runs tests, coverage, lint, custom post_task gates
  |
  v
for each epic in phase:
  review_start(epic_id)  -- Validates all tasks done, custom pre_review gates
    |
    v
  review_submit(epic_id, submissions) -- Gate 8: reviewer checks
    |
    v
  accept_start(epic_id)  -- Validates Gate 8 passed
    |
    v
  accept_submit(epic_id, criteria, user_approved) -- Gate 9: acceptance
  |
  v
phase_advance()          -- All epics done, advance to next phase
```

---

## Step 1 -- Initialize the Cycle

Call `cycle_init` with the path to the plan file:

```
cycle_init({ plan_path: "docs/plans/my-plan.md" })
```

The server parses the plan, creates initial state, and returns the cycle summary. If a cycle already exists, it returns an error -- use `cycle_reset` first.

After init, call `cycle_status` to see the full state and confirm Phase 1 tasks are ready.

---

## Step 2 -- Execute Tasks

For each task in order within the current phase:

### 2a. Start the task

```
task_start({ task_id: "1.1.1" })
```

Entry criteria enforced by the server:
- Task must be "pending" or "failed"
- Previous task in same epic must be "done"
- Custom `pre_task` gates must pass (if configured)
- Gate 1 infrastructure check runs (if dependency files changed)

### 2b. Implement the task

Read the plan's task description. Write the code, tests, and any supporting files. This is the creative work -- the server does not control what you build, only that it passes quality checks.

### 2c. Complete the task

```
task_complete({ task_id: "1.1.1" })
```

Gate 0 exit criteria enforced by the server:
- Configured test command must pass
- Coverage must meet threshold
- Configured lint command must pass
- Custom `post_task` gates must pass (if configured)

**If Gate 0 fails:** Read the evidence. Fix the failing check. Call `task_complete` again (the task stays in "doing" so you can retry without calling `task_start`).

---

## Step 3 -- Review Each Epic

After all tasks in an epic pass Gate 0:

### 3a. Start review

```
review_start({ epic_id: "1.1" })
```

The server validates all tasks are done and passed Gate 0. Custom `pre_review` gates run if configured.

### 3b. Submit review findings

```
review_submit({ epic_id: "1.1", submissions: "<JSON>" })
```

The `submissions` parameter is a JSON array of `ReviewFindings` objects:

```json
[
  {
    "reviewer": "code-quality",
    "findings": [
      { "severity": "medium", "description": "..." }
    ]
  }
]
```

Gate 8 checks: required reviewers present, critical/high finding counts within thresholds.

---

## Step 4 -- Accept Each Epic

### 4a. Start acceptance

```
accept_start({ epic_id: "1.1" })
```

Validates Gate 8 passed.

### 4b. Submit acceptance

```
accept_submit({
  epic_id: "1.1",
  criteria: "<JSON>",
  user_approved: true
})
```

The `criteria` parameter is a JSON array of `AcceptanceCriterion` objects:

```json
[
  { "criterion": "Config loads defaults when no file exists", "met": true, "evidence": "test passes" }
]
```

Gate 9 checks: all criteria met, user approval given (if required by config).

---

## Step 5 -- Advance Phase

After all epics in the current phase pass Gates 8 and 9:

```
phase_advance()
```

The server validates all epics are "done", marks the phase as complete, and activates the next phase. If this is the last phase, the cycle is finished.

---

## Rolling-Wave Elaboration

Rolling-wave plans leave later phases at epic level (no tasks) at plan time. The cycle parses the plan once at `cycle_init`, so tasks you add to a later-phase epic afterward are invisible to the server until you re-parse.

When execution reaches a phase whose epics still have no tasks, elaborate those tasks in the plan file, then:

```
cycle_reload()   -- re-parse the plan, merge new phases/epics/tasks into the running cycle
```

`cycle_reload` preserves the status and gate evidence of everything already in progress or done — it only **adds** newly-appeared entities. Do NOT use `cycle_reset` for this (that destroys all evidence). Run `cycle_reload` before `review_start` on any epic that was epic-level at init.

---

## Recovery Protocol

When something goes wrong, follow this order:

### 1. Diagnose first

```
cycle_diagnose()
```

Returns cycle health (healthy/degraded/corrupt), stuck entities, failed tasks, validation errors, evidence audit, and actionable suggestions referencing the exact management tool and params to use. Read the report before taking action.

### 2. Use management tools

Three granular tools for targeted fixes. All use the preview/confirm pattern (set `confirm: false` to preview, `confirm: true` to apply).

**task_manage** -- force_status, skip, retry, or reset_evidence for a single task:

```
task_manage({ task_id: "1.1.1", action: "retry", confirm: true })
task_manage({ task_id: "1.1.1", action: "force_status", target_status: "failed", confirm: true })
task_manage({ task_id: "1.1.1", action: "skip", confirm: true })
task_manage({ task_id: "1.1.1", action: "reset_evidence", confirm: true })
```

**epic_manage** -- force_status, reset_tasks, or skip for an epic (with optional cascade to child tasks):

```
epic_manage({ epic_id: "1.1", action: "force_status", target_status: "pending", cascade: true, confirm: true })
epic_manage({ epic_id: "1.1", action: "reset_tasks", cascade: false, confirm: true })
epic_manage({ epic_id: "1.1", action: "skip", cascade: true, confirm: true })
```

**phase_manage** -- force_status or skip for a phase (skip always cascades to all child epics and tasks):

```
phase_manage({ phase_id: "1", action: "skip", confirm: true })
phase_manage({ phase_id: "1", action: "force_status", target_status: "done", confirm: true })
```

### 3. Reset as last resort

```
cycle_reset({ confirm: false })  -- preview what will be lost
cycle_reset({ confirm: true })   -- destroy state and evidence
```

Only use this when the cycle is unrecoverable. Requires explicit confirmation.

---

## Anti-Patterns (Prohibited)

| Do NOT | Why |
|--------|-----|
| Edit `.rigor/state.json` directly | Bypasses transition validation; corrupts state |
| Edit or create files in `.rigor/evidence/` | Evidence must come from gate execution |
| Call `task_complete` before implementing | Tests will fail; you cannot fake passing |
| Call `phase_advance` before all epics are done | Server rejects it; wasted tool call |
| Invent review submissions with no real review | Defeats the purpose of Gate 8 |
| Set `user_approved: true` without asking the user | Gate 9 user approval requires real human input |
| Ignore gate failure messages | They contain the exact checks that failed; read them |
| Skip `cycle_diagnose` and go straight to `cycle_reset` | You may lose work that was recoverable |

---

## Status Reporting

After each gate passage or failure, report to the user:
- Which task/epic passed or failed
- Which checks passed/failed (from the evidence)
- Current overall progress (tasks done / total in phase)

After completing an epic (Gate 9 pass), show cumulative progress for the phase.

After `phase_advance`, summarize what was completed and what the next phase contains.
