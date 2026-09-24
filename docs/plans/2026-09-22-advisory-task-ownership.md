# Advisory Task Ownership Implementation Plan

> **For implementers:** This is a rolling-wave plan. Phase 1 tasks are
> dispatch-ready. Later phases are epic-level only -- elaborate them against
> the real codebase when execution reaches them.
> This document is the living source of truth -- task elaboration for later
> phases is written back into it during execution.

**Goal:** Replace enforced task leases with an optional advisory worker record so single-agent task execution cannot fail from expired or stale ownership while shared-worktree users receive a coordination warning.

**Architecture:** A `TaskState.worker` annotation replaces the time-bound `lease` fence. `task_start` optionally records an owner and warns, without blocking, when replacing a different worker on an existing `doing` task. Completion remains status- and Gate-0-driven; Gate 0 evidence retains its independent per-run attempt journal, while ownership, expiry, renewal, and takeover disappear from the MCP contract and persisted state.

**Tech Stack:** TypeScript, Node.js, MCP SDK, Vitest, JSON state/evidence.

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | Lease-free task start and completion work end-to-end with persisted advisory warnings | 1.1, 1.2 | Detailed |
| 2 | Recovery, migration, and public tool surface contain no lease semantics | 2.1, 2.2 | Epic-level |
| 3 | Documentation and worktree-oriented integration coverage establish supported multi-agent behavior | 3.1 | Epic-level |

---

## Phase 1: Lease-Free Task Lifecycle

### Epic 1.1: Replace the persisted lease model

**Goal:** Task state can record optional advisory worker metadata and never persists or depends on lease data.
**Scope:** `src/state/`, task-state fixtures and state-manager tests.
**Dependencies:** none
**Done when:** A started task stores only an optional worker ID and start timestamp; existing lease-bearing state loads successfully without a lease; state validation accepts the new shape; no exported task-lease/fence type or lease duration constant remains.
**Status:** Pending

#### Task 1.1.1: Define advisory worker state and load migration

- [ ] Done

**Context:** `TaskState` currently includes `lease?: TaskLease` at `src/state/schema.ts:129-135`; the lease type, fence result types, and five-minute constant occupy `src/state/schema.ts:79-127`. `StateManager.load()` parses state with no migration at `src/state/manager.ts:77-84`, and normal saves atomically replace `.rigor/state.json` at `:102-111`.

**Implementation vision:** Replace the full lease type family with an optional `TaskWorker` record `{ owner_id: string; started_at: string }` and `worker?: TaskWorker` on `TaskState`. On load, normalize persisted legacy tasks by removing their `lease` property before returning state; do not synthesize a worker from legacy ownership, because expired and stale lease data is deliberately discarded. Remove lease assertion/renewal APIs and any imports that exist only to support them. Extend validation to reject malformed worker values when present: owner must be a non-empty string and `started_at` must be a parseable timestamp. Preserve all non-lease state unchanged.

**Files:**
- Modify: `src/state/schema.ts:79-135`
- Modify: `src/state/manager.ts:18-34`, `src/state/manager.ts:77-84`, `src/state/manager.ts:242-305`, `src/state/manager.ts:387-395`
- Modify: `src/state/validator.ts:43-203`
- Test: `src/state/__tests__/manager.test.ts`
- Test: `src/state/__tests__/validator.test.ts`

**Verification:** `npm run build && npx vitest run src/state/` exits 0. Tests prove a legacy serialized lease is removed on load, valid worker metadata persists, malformed worker metadata is reported, and lease fence APIs/types no longer compile.

**Done when:** State has no lease or attempt ownership field; the migration is idempotent; valid advisory worker state survives a save/load round-trip.

#### Task 1.1.2: Remove renewal from the MCP contract

- [ ] Done

**Context:** The registered public schema exposes `task_start` ownership, `takeover`, and `lease_ms` at `src/tools/gate.ts:18-26`, a `task_renew` tool at `:28-36`, and `task_complete` owner/attempt requirements at `:38-46`. The tool is also part of the exported server capability surface and transport tests exercise it at `src/tools/__tests__/transport.integration.test.ts:293-327`.

**Implementation vision:** Delete `task_renew` registration and handler wiring. Narrow `task_start` to `task_id`, optional `owner_id`, and `project_root`; remove `takeover` and `lease_ms`. Narrow `task_complete` to `task_id` and `project_root`. Update response/context contracts so task-start responses contain no `attempt_id`, lease expiry, or completion instruction requiring identity. Update server-info/capability and transport tests to assert the removed tool and fields are absent rather than tolerated.

**Files:**
- Modify: `src/tools/gate.ts:18-46`
- Modify: `src/tools/response.ts:1-40`
- Modify: `src/tools/__tests__/gate.test.ts:110-150`, `:279-689`
- Modify: `src/tools/__tests__/server-info.test.ts`
- Modify: `src/tools/__tests__/transport.integration.test.ts:293-327`

**Verification:** `npm run build && npx vitest run src/tools/` exits 0. Tool schema tests reject `takeover`, `lease_ms`, `owner_id`/`attempt_id` on completion, and the transport inventory omits `task_renew`.

**Done when:** Agents have no renewal call to make and cannot be instructed to retain an attempt ID by any registered task tool response.

### Epic 1.2: Make start and completion advisory-only

**Goal:** Normal task work proceeds based on lifecycle status and Gate 0, with worker information serving solely as a start-time warning.
**Scope:** `src/services/task-lifecycle.ts`, lifecycle and tool tests.
**Dependencies:** Epic 1.1
**Done when:** An uncontended start records optional worker metadata; a competing start on a `doing` task continues with an actionable warning; completion runs without owner/attempt fencing and clears worker metadata for every terminal outcome.
**Status:** Pending

#### Task 1.2.1: Implement advisory worker behavior in task start

- [ ] Done

**Context:** Start blocks another active owner at `src/services/task-lifecycle.ts:143-160`, then creates an attempt UUID and expiring `TaskLease` at `:227-234`. The locked persistence block rechecks expiry and transitions status at `:235-261`; the response echoes owner, attempt, expiry, and an identity-bearing completion instruction at `:263-284`. Readiness, workspace policy, sequencing, git warning, custom gates, and Gate 1 all precede this code at `:108-225` and must not change.

**Implementation vision:** Keep all existing pre-start checks. For a `pending` or `failed` task, transition to `doing` and set `worker` only when a non-empty optional `owner_id` is supplied. For an already `doing` task, permit a new start only as the advisory-contended path: capture the prior worker before overwriting it, retain `doing`, and add one response warning only if the prior and new non-empty owners differ. The warning must name the previous owner and timestamp and tell users to coordinate file ownership or use separate worktrees. Do not warn for same owner, missing owner, or ordinary fresh starts. The locked recheck must allow this `doing` path without checking time. Return a plain completion instruction with task ID and project root only.

**Files:**
- Modify: `src/services/task-lifecycle.ts:100-284`
- Test: `src/tools/__tests__/gate.test.ts:279-399`
- Test: `src/services/task-lifecycle-readiness.integration.test.ts`

**Verification:** `npm run build && npx vitest run src/tools/__tests__/gate.test.ts src/services/task-lifecycle-readiness.integration.test.ts` exits 0. Cases cover no-owner start, recorded-owner start, contended different-owner warning and overwrite, same-owner start without warning, and unchanged readiness/worktree blocking.

**Done when:** Starting another agent's `doing` task never returns an ownership error, and the only coordination signal appears in that start response.

#### Task 1.2.2: Remove completion fences and clear worker state

- [ ] Done

**Context:** Completion rejects missing/mismatched owner and attempt fields and expired leases at `src/services/task-lifecycle.ts:423-432`. It generates Gate-0 evidence with ownership information at `:448-462` and repeatedly reasserts persisted lease fences before evidence/status writes at `:463-524`. The in-process duplicate guard at `:35-53` and `:361-369` prevents duplicate Gate-0 execution and remains required.

**Implementation vision:** Delete all lease/legacy-completion branching and fence checks. Generate a fresh Gate-0 evidence attempt ID internally for each completion invocation; use `owner_id: "legacy"` in the evidence journal only if the existing evidence schema still requires the field, without exposing it through task-tool input. Inside each mutation lock, reload state, require the task to remain `doing`, and then write evidence or promote terminal evidence. If the task changed status while Gate 0 ran, retain history and return the existing stale-result outcome rather than overwriting state. Clear `worker` in every terminal state transition: Gate-0 failure, execution error, post-task custom gate failure, and success. Do not add completion warnings about worker identity.

**Files:**
- Modify: `src/services/task-lifecycle.ts:35-60`, `:354-617`
- Test: `src/tools/__tests__/gate.test.ts:696-744`
- Test: `src/evidence/__tests__/manager.test.ts`

**Verification:** `npm run build && npx vitest run src/tools/__tests__/gate.test.ts src/evidence/__tests__/manager.test.ts` exits 0. Tests prove completion accepts no ownership fields, duplicate in-process completion is still guarded, each terminal outcome clears worker, and Gate-0 attempt history remains written.

**Done when:** No legitimate one-agent completion can fail because of owner, attempt, expiry, or takeover state; Gate 0 evidence and status transitions remain deterministic.

---

## Phase 2: Recovery and Compatibility Cleanup

### Epic 2.1: Remove lease recovery semantics

**Goal:** Diagnosis, retry, and task management recover interrupted Gate-0 work without lease-specific states, instructions, or inaccessible ownership parameters.
**Scope:** `src/services/recovery-lifecycle.ts`, `src/tools/recovery.ts`, recovery tests.
**Dependencies:** Phase 1
**Done when:** Retry and recovery clear advisory worker metadata; diagnostics report interrupted evidence without calling a task lease stuck; task management has no owner/attempt/takeover schema drift; all recovery guidance offers ordinary retry/start actions.
**Status:** Pending

#### Task 2.1.1: Verify advisory recovery and remove stale lease language

- [ ] Done

**Context:** Phase 1 removed `TaskLease` and ownership fields from the public task tools. `handleTaskRetry` already clears `worker` at `src/services/recovery-lifecycle.ts:186-203`; diagnostic reconciliation transitions terminal tasks through `StateManager.transition` at `:771-875`, which now centrally clears workers on every non-`doing` transition (`src/state/manager.ts:177-213`, `:224-241`). `TaskManageParams` no longer declares owner/attempt/takeover at `src/services/recovery-lifecycle.ts:219-225`.

**Implementation vision:** Audit every recovery action and diagnostic suggestion for expired-lease, takeover, owner, or attempt-ownership semantics. Keep Gate-0 attempt evidence IDs, which are evidence history rather than ownership fences. Ensure retry, reset, force-status, skip, and interrupted Gate-0 reconciliation leave no worker on a task that is no longer `doing`. Update stale test labels/messages that describe advisory worker behavior as leases, but retain legacy-lease fixture wording where it specifically documents migration input.

**Files:**
- Modify: `src/services/recovery-lifecycle.ts:132-212`, `:219-390`, `:771-875`
- Modify: `src/services/recovery-lifecycle.test.ts`
- Modify: `src/services/task-lifecycle-readiness.integration.test.ts:34`
- Test: `src/services/recovery-lifecycle.test.ts`

**Verification:** `npm run build && npx vitest run src/services/recovery-lifecycle.test.ts src/services/task-lifecycle-readiness.integration.test.ts` exits 0. Tests prove recovery of an interrupted/stale Gate-0 attempt reaches a terminal task without worker metadata; retry and administrative task actions clear workers; suggestions use only ordinary `task_manage retry`/`task_start` calls.

**Done when:** Recovery has no operational lease, expiry, takeover, owner-fence, or attempt-fence behavior; evidence-attempt history remains intact and terminal tasks cannot retain advisory worker metadata.

### Epic 2.2: Verify state/evidence compatibility

**Goal:** Upgraded projects and existing evidence histories operate safely after the lease model is removed.
**Scope:** state fixtures, evidence reconciliation, multi-project lifecycle tests.
**Dependencies:** Epic 2.1
**Done when:** Legacy `state.json` fixtures with live, expired, malformed, and takeover-history leases load without lifecycle errors; no legacy lease data is re-saved; interrupted attempt reconciliation preserves historical evidence and clears advisory worker state.
**Status:** Pending

#### Task 2.2.1: Exercise legacy state through recovery and transport boundaries

- [ ] Done

**Context:** `StateManager.migrate()` strips an unknown legacy `lease` property while loading state at `src/state/manager.ts:77-91`; unit coverage currently verifies raw state migration at `src/state/__tests__/manager.test.ts:488-622`. Completion already proves it ignores legacy lease data at `src/tools/__tests__/gate.test.ts:837-856`. Transport tests assert separate project roots retain independent workers and omit `task_renew` at `src/tools/__tests__/transport.integration.test.ts:293-318`.

**Implementation vision:** Add integration coverage that writes legacy lease-bearing state directly, then invokes recovery/diagnostic and normal lifecycle operations through their public service or transport boundary. Cover live, expired, malformed, and takeover-history legacy shapes without interpreting their expiry; the only permitted outcome is lease removal on load and normal status/evidence behavior. For an interrupted Gate-0 attempt carrying an advisory worker, assert reconciliation writes terminal attempt history, transitions to `failed`, and clears worker. Assert a subsequent save does not restore legacy lease data.

**Files:**
- Modify: `src/services/recovery-lifecycle.test.ts`
- Modify: `src/tools/__tests__/transport.integration.test.ts`
- Modify: `src/state/__tests__/manager.test.ts`

**Verification:** `npm run build && npx vitest run src/state/__tests__/manager.test.ts src/services/recovery-lifecycle.test.ts src/tools/__tests__/transport.integration.test.ts` exits 0. The full configured Gate 0 suite (`npx vitest run src/`) also exits 0.

**Done when:** An upgraded worktree never rejects lifecycle/recovery work because of legacy lease data, never persists that data after a save, and preserves Gate-0 evidence history while clearing terminal advisory workers.

---

## Phase 3: Worktree Documentation and Integration Validation

### Epic 3.1: Document and validate supported multi-agent worktree operation

**Goal:** Users understand that worktrees isolate state for separate repos/worktrees and that same-worktree coordination is advisory and user-managed.
**Scope:** `README.md`, relevant skill/docs, multi-project/worktree integration tests.
**Dependencies:** Phase 2
**Done when:** Documentation states the A/B/C operating model, does not mention task lease renewal or takeover, and integration tests prove independent worktrees do not share state while a same-worktree competing start emits the exact advisory warning.
**Status:** Pending

#### Task 3.1.1: Document advisory coordination and validate worktree isolation

- [ ] Done

**Context:** Every worktree owns independent cycle state under `<worktree>/.rigor/state.json` (`src/state/manager.ts:43-63`), while the request context resolves an explicit root per lifecycle call (`src/context.ts:96-125`). Existing transport coverage proves project-root worker separation at `src/tools/__tests__/transport.integration.test.ts:318-340`, and unit coverage proves a same-root competing start overwrites the advisory worker and emits the coordination warning at `src/tools/__tests__/gate.test.ts:288-315`. The user-approved A/B/C operating model is: one agent across multiple repos; multiple agents on different repos; and multiple agents in one repo with user-managed different-file coordination.

**Implementation vision:** Add a concise README section defining the three supported worktree modes. State that each active worktree needs its own absolute `project_root` and therefore its own Rigor state/evidence; user-visible worker metadata is optional, advisory only, and appears only as a warning when another owner starts the same task in the same worktree. Explicitly state that Rigor does not schedule agents or prevent same-repo file conflicts, so the user must assign non-overlapping files. Remove any remaining operational references to lease renewal/takeover from user documentation (historical design/plan references are excluded). Add an MCP transport-boundary same-root test that starts a task as owner A then owner B and asserts successful second start, exact warning content, and worker B persisted; retain the existing separate-root test as proof that state is isolated.

**Files:**
- Modify: `README.md:86-114`, `:150-171`
- Modify: `docs/architecture.md:65-82`
- Modify: `src/tools/__tests__/transport.integration.test.ts:293-340`
- Test: `src/tools/__tests__/transport.integration.test.ts`

**Verification:** `npm run build && npx vitest run src/tools/__tests__/transport.integration.test.ts` exits 0. The full configured Gate 0 suite (`npx vitest run src/`) exits 0. Tests prove two different roots persist independent workers and one root permits a competing start with the exact advisory warning and replacement worker.

**Done when:** Users can select the A/B/C worktree mode from documentation without seeing obsolete lease instructions, and transport tests prove both root isolation and same-root advisory coordination end-to-end.

---

## Self-Review

- **Spec coverage:** Lease/attempt/expiry removal is covered by Phase 1; advisory warnings and worker lifecycle are covered by Epic 1.2; separate-worktree and same-worktree models are covered by Epic 3.1; recovery/migration are covered by Phase 2.
- **Vagueness scan:** Phase 1 tasks name all transition paths, user-visible warning conditions, migration behavior, and verification commands.
- **Contract consistency:** `TaskWorker` is the sole persisted coordination record; `task_start` alone accepts optional `owner_id`; `task_complete` never accepts ownership fields; no `task_renew` API remains.
- **Phase boundaries:** Phase 1 leaves a complete lease-free lifecycle that builds and has focused tests. Phase 2 makes recovery consistent with it. Phase 3 validates and documents the supported operating modes.
- **Verification plausibility:** The configured Gate 0 commands are `npm run build` and `npx vitest run src/`; each detailed task uses build plus focused tests, with the full configured suite available at epic completion.
