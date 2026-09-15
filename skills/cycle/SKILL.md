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

## Execution Mode

Before starting lifecycle work, use the host's formal user-question mechanism when available to ask the user to choose one session-scoped mode:

1. **Stepwise** -- report each gate passage, failure, and milestone, then wait for the user to continue.
2. **Continuous** -- continue task implementation, Gate 0 retries, Gate 8 remediation and resubmission, and phase advancement without ordinary confirmation prompts. Report progress as work continues; do not pause after successful tasks, failed reviews, remediations, or phase transitions.

Before `cycle_init`, agents MUST also establish the execution workspace and commit cadence:

1. **Workspace:** use `rigor:worktree` and execute the cycle in an isolated worktree. This is mandatory for planned feature work and multi-agent execution. Skip only when already inside the feature's worktree or when the user explicitly chooses a quick fix on the current branch.
2. **Commit cadence:** ask through the host's formal question mechanism whether to commit completed work per **task**, **epic**, or **phase**. Do not ask again unless the user requests a change. The cadence controls commit timing only; it never bypasses Gate 0, Gate 8, Gate 9, review, or push requirements.

### Delegated implementation workspace rule

When dispatching an implementation subagent, give it the active worktree's absolute path and require it to run `git rev-parse --show-toplevel` before editing. It may proceed only if the result exactly matches that path. A delegated subagent must not create, enter, inspect, or edit another worktree; invoke `rigor:worktree`; invoke `git worktree`; or edit the main checkout. On a mismatch, it must stop and report it without attempting to create a replacement workspace.

The mode, workspace choice, and commit cadence are orchestration preferences only: never persist them in `.rigor/state.json` and never bypass an MCP gate. In either mode, stop for Gate 9 when configuration requires user approval; present the acceptance criteria through the host's formal user-question mechanism and wait for actual approval before submitting `user_approved: true`. Never infer approval from a free-form continuation message or silently set `user_approved: true`.

In Continuous mode, Gate 8 failure is not a user-confirmation point. Read the findings, implement the safest compliant remediation, rerun required verification, and resubmit the review directly. Stop only when human direction is genuinely required: requirements or acceptance evidence are ambiguous, a rolling-wave phase has no elaborated tasks, recovery diagnosis cannot identify a safe action, a gate failure cannot be remediated safely, or there are two or more materially different viable implementation approaches whose choice affects requirements, compatibility, security, or architecture. Present those alternatives and ask the user to choose. Also stop if the user explicitly interrupts execution. Do not ask for continuation merely because a task, review, remediation, or phase passed or failed.

---

## HARD STOP -- UNDERSTAND THE RULES

1. **You never edit `.rigor/state.json` or `.rigor/evidence/` files directly.** All state changes go through MCP tools.
2. **You never fabricate evidence.** If a gate fails, fix the underlying issue and retry. Do not invent passing results.
3. **You never skip a gate.** Every task passes Gate 0. Every epic passes Gates 8 and 9. Every phase passes all epics before advancing.
4. **You never call `task_complete` without implementing.** The server runs real tests/lint -- empty implementations fail.

---

## Lifecycle Sequence

Every lifecycle tool call must pass the active isolated worktree's absolute `project_root`; never rely on the MCP server default, which may point at another checkout. Use the same root for initialization, tasks, reviews, acceptance, reload, reset, and management calls. `cycle_status` and `cycle_diagnose` are currently server-root-bound, so use them only when the server is configured for this worktree.

```
cycle_init({ plan_path: "docs/plans/my-plan.md", project_root: "C:/path/to/worktree" })
  |
  v
for each task in phase:
  task_start(task_id, project_root)    -- Gate entry: validates order, custom pre_task gates, Gate 1
    |
    v
  [implement the task]
    |
    v
  task_complete(task_id, project_root) -- Gate 0: runs tests, coverage, lint, custom post_task gates
  |
  v
for each epic in phase:
  review_start(epic_id, project_root)  -- Validates all tasks done, custom pre_review gates
    |
    v
  review_submit(epic_id, submissions, project_root) -- Gate 8: reviewer checks
    |
    v
  accept_start(epic_id, project_root)  -- Validates Gate 8 passed
    |
    v
  accept_submit(epic_id, criteria, user_approved, project_root) -- Gate 9: acceptance
  |
  v
phase_advance(project_root)          -- All epics done, advance to next phase
```

---

## Step 1 -- Initialize the Cycle

### Preconditions

Before calling `cycle_init`, verify that the current checkout is a linked Git worktree on a non-base feature branch. Confirm the worktree path and branch with Git, and confirm that the plan belongs to this checkout. If the checkout is not isolated, hand off to `rigor:worktree` before continuing. Do not initialize a cycle from a detached HEAD, the repository's base branch, or a non-worktree checkout.

| Rejection | Remediation |
|-----------|-------------|
| Detached HEAD | Check out or create the intended feature branch, then verify it is a linked worktree. |
| Base branch | Create or switch to a non-base feature branch in a linked worktree; do not initialize on the base branch. |
| Not a linked worktree | Hand off to `rigor:worktree` and continue from the created worktree. |
| Foreign cycle | Stop and use the cycle belonging to the active worktree; do not reset, overwrite, or adopt a cycle from another checkout. |
| Any precondition failure rationalized as temporary or harmless | Treat the rejection as blocking, remediate it, and re-run every precondition check before calling `cycle_init`. |

Never call `cycle_reset` for a foreign cycle. `cycle_reset` may only be used for an unrecoverable cycle that belongs to the active worktree, after diagnosis and explicit confirmation.

Call `cycle_init` with the path to the plan file and the active worktree's absolute `project_root`:

```
cycle_init({ plan_path: "docs/plans/my-plan.md", project_root: "C:/path/to/worktree" })
```

The server parses the plan, creates initial state, and returns the cycle summary. If a cycle already exists for this worktree, diagnose it and use `cycle_reset` only as a last resort; never reset a foreign cycle.

**Project root:** when you pass an **absolute** `plan_path` that sits inside a git repository whose root differs from the server's `--project-root`, `cycle_init` writes `.rigor/` state and evidence under the plan's git root (the reliable signal) and returns a `warning` plus the derived `project_root` in the summary. `cycle_status`/`task_*` still read the server root, so the warning is your cue to restart the server with the correct `--project-root`. A relative `plan_path`, or a plan outside any repo, keeps the server root unchanged.

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

**Duplicate completion calls:** Within one server, a duplicate `task_complete` while Gate 0 is running returns the active attempt identity and polling guidance; it never reruns checks. Poll `cycle_status` for progress, then call `task_complete` again only after the task reaches a terminal state. A duplicate request for a terminal `done` or `failed` task with matching persisted Gate 0 evidence returns that evidence idempotently without rerunning checks.

**If Gate 0 fails:** The task transitions to `failed` (it does not remain in "doing"). Read the evidence, fix the failing check, then call `task_start({ task_id })` again -- its entry criteria accept a `failed` task -- to move it back to "doing" and retry. Never fabricate evidence to force a pass.

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

**If Gate 8 fails:** Read the saved findings and remediate them. In Stepwise mode,
wait for the user before re-reviewing. In Continuous mode, remediation and
resubmission are automatic: implement the safest compliant fix, run the required
verification, and submit the updated reviewer results directly with `review_submit`
without asking for continuation. Do not call `review_start` a second time.

If the findings admit two or more materially different viable fixes and the choice
affects requirements, compatibility, security, or architecture, use the host's
formal user-question mechanism to present the alternatives and wait for selection
before editing. Otherwise choose the minimal safe remediation and continue
automatically.

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

The server validates all epics are "done", marks the phase as complete, and activates the next phase. If this is the last phase, it snapshots the completed state and evidence under `.rigor/history/`, validates the archive, clears active artifacts, and finishes the cycle. If archival fails, active artifacts remain for recovery.

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

**After a server restart or reconnect:** Call `cycle_diagnose` before any management action. It reconciles a persisted terminal Gate 0 attempt with a `doing` task, leaves a live in-process attempt untouched, and classifies an unfinished attempt as `interrupted` when it is not active. An inactive attempt older than the stale threshold is reported as `stale` before reconciliation; both stale and interrupted attempts are finalized as interrupted and moved to `failed`. Diagnostics list the task's project/cycle identity, latest attempt, and compact prior-attempt outcomes. Follow only its recommendation: retry interrupted, stale, or failed work; take no action for a recovered pass; and reset evidence only when it reports inconsistent evidence. `cycle_status` is read-only; use it to inspect progress, not to recover state.

**Retry semantics:** Retry only a `failed` task with `task_manage({ action: "retry", confirm: true })`. Retry removes the current Gate 0 summary and resets the task for `task_start`, but preserves every terminal attempt in nested Gate 0 history. The next `task_start` and `task_complete` create a new attempt; do not restore or overwrite an earlier attempt.

**Task evidence cleanup:** Backward task resets and `reset_evidence` remove task-owned Gate 0 summaries and history, Gate 1, and post-task custom evidence. They preserve the parent epic's Gate 8 and Gate 9 review/acceptance evidence. Cycle reset and completed-cycle archival include nested Gate 0 attempt-history files.

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
| Ask the user whether to continue after a Gate 8 failure in Continuous mode | Gate 8 remediation and resubmission are part of the automatic cycle; continue unless materially different solutions require a decision |
| Skip `cycle_diagnose` and go straight to `cycle_reset` | You may lose work that was recoverable |
| Dispatch an implementation subagent without naming the active worktree and requiring a `git rev-parse --show-toplevel` match | The subagent can silently edit another worktree or the main checkout, forking the task away from the cycle's state |
| Let a delegated subagent create its own worktree or branch | Its work lands outside the cycle's branch history and evidence, and must be re-verified before it can be trusted |

---

## Status Reporting

After each gate passage or failure, report to the user:
- Which task/epic passed or failed
- Which checks passed/failed (from the evidence)
- Current overall progress (tasks done / total in phase)

In Stepwise mode, wait for user continuation after each ordinary milestone. In
Continuous mode, treat these as progress updates and continue immediately; pause
only at Gate 9 approval or a genuine blocker described in **Execution Mode**.

After completing an epic (Gate 9 pass), show cumulative progress for the phase.

After `phase_advance`, summarize what was completed and what the next phase contains.
