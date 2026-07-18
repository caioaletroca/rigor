# Extended Recovery Tools -- Design Document

> **Status:** Approved
> **Date:** 2026-07-17
> **Exploration:** 3 alternatives evaluated

## Context

Running development cycles with multiple concurrent AI agents exposes edge cases where tasks get stuck in invalid states, need to be reverted, or skipped entirely. The current recovery tools (`cycle_reset`, `task_retry`, `cycle_diagnose`) are too limited -- `cycle_reset` is nuclear, `task_retry` only handles one narrow case, and `cycle_diagnose` is read-only. The agent needs granular state mutation tools with user confirmation to self-recover without human JSON editing.

## Architecture

Extends the existing recovery tool group in `src/tools/recovery.ts`. The current 3 tools become 5 by renaming `task_retry` to `task_manage` and adding `epic_manage` and `phase_manage`. The state machine in `src/state/schema.ts` gets expanded transitions to support force operations and a new `skipped` status.

All mutating tools require a `confirm: boolean` parameter (existing pattern from `cycle_reset`). Preview mode (`confirm=false`) shows what would change; execute mode (`confirm=true`) applies changes. The agent must show the preview to the user and get approval before confirming.

## Components

| Component | Type | Purpose |
|-----------|------|---------|
| `src/state/schema.ts` | modify | Add `skipped` status, force transitions |
| `src/state/manager.ts` | modify | Add bulk status update + evidence cleanup methods |
| `src/tools/recovery.ts` | modify | Rename `task_retry` → `task_manage`, add `epic_manage` + `phase_manage` |
| `src/tools/__tests__/recovery.test.ts` | modify | Tests for new/renamed tools |
| `src/server.ts` | modify | Update tool registration (names changed) |
| `skills/cycle/SKILL.md` | modify | Update `task_retry` references to `task_manage` |

## Tools After Change

| Tool | Operations | Parameters |
|------|-----------|------------|
| `task_manage` | `force_status`, `skip`, `retry`, `reset_evidence` | `task_id`, `action`, `status?`, `confirm` |
| `epic_manage` | `force_status`, `reset_tasks`, `skip` | `epic_id`, `action`, `status?`, `confirm` |
| `phase_manage` | `force_status`, `skip` | `phase_id`, `action`, `status?`, `confirm` |
| `cycle_reset` | *(unchanged)* | `confirm` |
| `cycle_diagnose` | *(unchanged + auto-suggest fixes)* | *(none)* |

### task_manage actions

- **`force_status`**: Set any task to any valid status. Cleans up evidence if moving backward (`done`/`failed` → `pending`/`doing`).
- **`skip`**: New status `skipped` -- task is excluded from gate checks and progress calculations.
- **`retry`**: Same as current `task_retry` (clear `gate_0` evidence, keep `failed` status so `task_start` can re-enter).
- **`reset_evidence`**: Delete evidence files for a task without changing status.

### epic_manage actions

- **`force_status`**: Set epic to any status. Optionally cascade to all child tasks.
- **`reset_tasks`**: Reset all tasks in an epic to `pending`, clearing their evidence. Useful when requirements change.
- **`skip`**: Mark epic as `skipped`.

### phase_manage actions

- **`force_status`**: Set phase to any status.
- **`skip`**: Mark phase as `skipped`, skip all its epics and tasks.

## State Machine Changes

Current transitions:
```
pending → doing → done
                → failed → doing (retry)
```

New transitions (force mode):
```
ANY → ANY        (when action is force_status)
ANY → skipped    (when action is skip)
```

The `skipped` status is new. Skipped entities:
- Are excluded from progress percentage calculations
- Are treated as "passing" for gate entry/exit checks
- Can be moved back to `pending` via `force_status`

## Data Flow

### Force status (with confirmation pattern)

1. Agent calls `task_manage(task_id="1.2.3", action="force_status", status="pending", confirm=false)`
2. Tool returns **PREVIEW**: "Would change task 1.2.3 from 'done' to 'pending'. Evidence file `gate_0-task-1.2.3.json` would be deleted. Call again with `confirm=true` to apply."
3. Agent shows preview to user, asks for approval
4. User approves
5. Agent calls `task_manage(..., confirm=true)`
6. Tool applies change, cleans up evidence, returns confirmation

### Cascade reset

1. Agent calls `epic_manage(epic_id="1.2", action="reset_tasks", confirm=false)`
2. Tool returns **PREVIEW**: "Would reset 5 tasks in epic 1.2 to 'pending'. 3 evidence files would be deleted."
3. Agent gets user approval, calls with `confirm=true`
4. Tool resets all tasks, cleans evidence, returns confirmation

### Diagnose with suggestions

1. Agent calls `cycle_diagnose()`
2. Tool returns health status + structured suggestions: `{ suggestion: "task_manage", params: { task_id: "1.2.3", action: "force_status", status: "pending" }, reason: "Task stuck in 'doing' for >1h" }`
3. Agent presents suggestions to user for approval

## Key Decisions

| Decision | Chosen | Rejected Alternative | Why |
|----------|--------|---------------------|-----|
| `skipped` as new status | First-class status in schema | Boolean `skipped` flag | Cleaner state machine; status is mutually exclusive |
| Preview/confirm pattern | Reuse `cycle_reset`'s `confirm` param | Separate preview tool | Consistent with existing pattern, no new tools |
| Evidence cleanup on backward transitions | Automatic | Manual via `reset_evidence` | Stale evidence causes confusing gate failures |
| Cascade on `epic_manage` | Optional (explicit action) | Always cascade | User may want to reset epic status without touching tasks |
| `cycle_diagnose` suggests fixes | Return structured actionable suggestions | Just report problems | Agent can directly act on suggestions |

## Open Questions

1. Should `cycle_diagnose` return structured suggestions (e.g., exact tool call params) or text descriptions? Structured is more actionable for the agent but adds schema complexity.

## Alternatives Considered

### Option A: Granular Tools (One Tool Per Operation)

Individual MCP tools for each operation (`task_force_status`, `epic_force_status`, `bulk_update`, `evidence_cleanup`, etc.). Rejected because it would grow the tool count from 11 to 18+ and add registration boilerplate, with no functional advantage over the action-parameter approach.

### Option B: Unified State Management Tool

Single `state_manage` tool with an `action` parameter routing to all operations. Rejected because variable-shape input schemas are hard to describe and validate, and the agent would have less discoverability compared to entity-scoped tools (`task_manage`, `epic_manage`, `phase_manage`).
