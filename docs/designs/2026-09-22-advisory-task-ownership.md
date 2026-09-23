# Advisory Task Ownership (Lease Removal) -- Design Document

> **Status:** Approved
> **Date:** 2026-09-22
> **Exploration:** 3 alternatives evaluated

## Context

The task lease system enforces per-task ownership through a 5-minute expiry, a UUID attempt identity, explicit takeover, and fence checks on every renewal and completion. In practice the failures it produces fall on the ordinary single-agent case: a stale `attempt_id` after a restart, or a lease that expires during a long test run, both of which reject legitimate work. The protection it appears to offer is weaker than it looks, because mutation locking is in-process only (`src/lifecycle/mutation-coordinator.ts:15-35`) and cross-process exclusion was explicitly out of scope.

Rigor must support three usage modes, all worktree-based: one agent across multiple repos, multiple agents across different repos, and multiple agents in one repo where the user is responsible for keeping them on different files. Only the third mode benefits from any ownership signal, and there a warning is sufficient.

## Architecture

Isolation moves entirely to the filesystem boundary that already provides it: each worktree owns its own `<root>/.rigor/state.json` (`src/state/manager.ts:4`, `:60-62`). Task ownership becomes a recorded annotation rather than an enforced fence, surfaced as a warning when a second worker declares itself on a task already in progress in the same root.

Time is removed from the model. No expiry, no renewal, no attempt identity in ownership, no takeover ceremony.

Gate 0 attempt evidence and `cycle_diagnose` reconciliation are untouched. They already detect interrupted work from evidence alone (`src/evidence/manager.ts:106-139`, `src/services/recovery-lifecycle.ts:810-875`, `:895-911`) without consulting leases.

## Components

| Component | Type | Purpose |
|---|---|---|
| `TaskLease`, `TaskLeaseHistory`, `LeaseFence*`, `TASK_LEASE_DURATION_MS` (`src/state/schema.ts:79-127`) | Remove | Replaced by a single worker record. |
| `TaskWorker` on `TaskState` (`src/state/schema.ts:129-135`) | New | Optional `{ owner_id, started_at }`. |
| `assertPersistedLease`, `renewPersistedLease`, `assertPersistedLegacyLease`, `isValidLease` (`src/state/manager.ts:242-305`, `:387-395`) | Remove | No fence to assert. |
| `task_renew` tool (`src/tools/gate.ts:28-36`) | Remove | Nothing to renew. |
| `task_start` schema (`src/tools/gate.ts:18-26`) | Modify | `owner_id` optional; drop `takeover` and `lease_ms`. |
| `task_complete` schema (`src/tools/gate.ts:38-46`) | Modify | Drop `owner_id` and `attempt_id`. |
| `handleTaskStart` (`src/services/task-lifecycle.ts:143-160`, `:227-284`) | Modify | Warn on a differing worker; never block; no attempt UUID or expiry in the response. |
| `handleTaskRenew` (`src/services/task-lifecycle.ts:306-347`) | Remove | -- |
| `handleTaskComplete` (`src/services/task-lifecycle.ts:423-445`, `:448-524`) | Modify | Drop fence re-checks; retain Gate 0 evidence promotion and the in-process duplicate guard (`:35-53`). |
| `TaskManageParams` owner/attempt/takeover (`src/services/recovery-lifecycle.ts:219-227`, `:281-299`) | Modify | Remove drifted fields and the expired-lease takeover branch. |
| Retry handling (`src/services/recovery-lifecycle.ts:163-204`) | Modify | Clear `worker` instead of `lease`. |
| State load migration (`src/state/manager.ts:77-84`) | New | Drop the inert `lease` field from existing state files. |
| Lease tests (`src/state/__tests__/manager.test.ts:477-667`, `src/tools/__tests__/gate.test.ts:590-744`, `src/tools/__tests__/transport.integration.test.ts:293-327`) | Modify | Replace fence coverage with warning and migration coverage. |

## Data Flow

**Start, uncontended**

1. Agent calls `task_start({ task_id, project_root })`, optionally with `owner_id`.
2. Readiness, workspace policy, task sequencing, git status, pre-task custom gates, and Gate 1 run unchanged (`src/services/task-lifecycle.ts:108-225`).
3. Under the project mutation lock, status becomes `doing` and `worker` is set to `{ owner_id, started_at }`.
4. The response reports task, status, and worker. No attempt ID and no expiry line.

**Start, contended (multiple agents, one repo)**

1. The task is already `doing` with `worker.owner_id` set to another agent.
2. The call succeeds and `worker` is overwritten with the new agent.
3. The response leads with a warning naming the prior worker and its `started_at`, and advises coordinating file ownership or using separate worktrees.

**Complete**

1. Agent calls `task_complete({ task_id, project_root })`.
2. The in-process duplicate-completion guard still applies.
3. Gate 0 runs; attempt evidence and attempt history are written as today; status is promoted on pass.
4. `worker` is cleared. No ownership check can reject a valid result.

**Interrupted session**

1. An agent dies mid-Gate-0; the task remains `doing` with in-progress attempt evidence.
2. `cycle_diagnose` classifies the attempt as interrupted or stale, writes terminal evidence, and sets the task `failed`, clearing `worker`.
3. The agent retries with an ordinary `task_start`. No takeover flag exists.

## Key Decisions

| Decision | Chosen | Rejected Alternative | Why |
|---|---|---|---|
| Enforcement model | Advisory warning | Hard ownership fence | The fence never held cross-process; it primarily blocked the legitimate single agent. |
| Expiry | None | Keep the 5-minute lease | Expiry during long test runs was a primary failure source, and renewal discarded caller-supplied `lease_ms`. |
| Attempt identity | Removed from ownership | Keep `attempt_id` on calls | Stale attempt IDs were the top single-agent failure; Gate 0 evidence keeps its own attempt history. |
| `owner_id` | Optional | Required | Single-agent and separate-repo modes never need it; only the shared-repo mode benefits. |
| Isolation for separate repos | Per-worktree `.rigor/state.json` | Central ownership registry | Already true, already tested, no new machinery. |
| Shared-repo safety | User coordinates files | Rigor-side file scheduling | The user owns conflict avoidance; scheduling is out of scope. |
| Warning placement | `task_start` only | Also warn on `task_complete` | Completed work is completed work; a late warning changes nothing. |
| `worker` lifetime | Cleared on completion, retry, and failure | Retained as audit history | It is coordination state; the human is accountable for the work. |
| `cycle_status` surface | Do not display `worker` | Display it | Noise for the common single-agent modes. |
| Existing state files | Silently drop `lease` on load | Dedicated migration tool | The field is inert once fences are removed. |

## Open Questions

None.

## Alternatives Considered

**Option 1 -- Remove ownership entirely.** Delete leases and record nothing about who started a task. Cheapest in agent tokens and simplest to reason about, but leaves the shared-repo mode with no signal at all that another agent is mid-task. Rejected because that mode is a supported goal, and the warning costs almost nothing.

**Option 2 -- Keep leases but hide them from the agent.** Derive `owner_id` from the MCP session, default the attempt, auto-renew on activity, and auto-take-over on expiry. Fixes the single-agent failures without losing fencing, but keeps all the lease code and adds session-identity plumbing, while auto-takeover quietly erodes the guarantee the fence exists to provide. Rejected for combining the costs of leases with the safety of none.
