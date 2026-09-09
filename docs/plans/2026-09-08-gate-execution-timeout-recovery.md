# Gate Execution Timeout and Recovery Implementation Plan

> **For implementers:** This is a rolling-wave plan. Phase 1 tasks are
> dispatch-ready. Later phases are epic-level only -- elaborate them against
> the real codebase when execution reaches them.
> This document is the living source of truth -- task elaboration for later
> phases is written back into it during execution.

**Goal:** Make Rigor gate execution observable, timeout-accurate, and recoverable without misreporting client/MCP timeouts as failed test commands.

**Architecture:** Replace the synchronous Gate 0 command execution path with an asynchronous, abortable process runner that records explicit lifecycle metadata for each gate attempt. Persist an in-progress attempt before command execution and a terminal result atomically after it ends, so subsequent `task_complete`, `cycle_status`, and `cycle_diagnose` calls can reconcile completed work instead of requiring manual retry/reset loops. Keep Gate 0’s deterministic pass/fail semantics and existing evidence contract compatible for completed attempts.

**Tech Stack:** TypeScript, Node.js child processes, MCP SDK, Vitest, JSON state/evidence.

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | Gate 0 commands no longer block the MCP event loop and produce explicit timeout/cancellation evidence | 1.1, 1.2 | Detailed |
| 2 | Clients can observe an in-progress gate and reconnect to its persisted terminal outcome | 2.1, 2.2 | Epic-level |
| 3 | Recovery and diagnostics reconcile interrupted attempts without deleting historical failure evidence | 3.1, 3.2 | Epic-level |

---

## Phase 1: Accurate, Non-Blocking Gate Execution

### Epic 1.1: Asynchronous abortable command runner

**Goal:** Gate commands run without blocking MCP status/diagnostic handlers and terminate predictably on their configured timeout or caller cancellation.
**Scope:** `src/executor/runner.ts`, Gate 0/custom-gate callers, runner tests.
**Dependencies:** none
**Done when:** a long-running command does not prevent unrelated event-loop work; configured command timeout terminates the process and returns `timed_out: true`; cancellation terminates the child process and reports cancellation distinctly from test failure; existing success, non-zero-exit, cwd, environment, and output-capture behavior remains covered.
**Status:** Pending

#### Task 1.1.1: Introduce the asynchronous command-runner contract

- [ ] Done

**Context:** `src/executor/runner.ts:47-88` uses synchronous `spawnSync`, which blocks the Node.js event loop for the whole command lifetime. `RunOptions` at `runner.ts:24-28` currently accepts only cwd, command timeout, and environment; result values at `runner.ts:15-22` distinguish only success/failure and `timed_out`. Gate 0 calls it at `src/gates/gate0.ts:62-95`, while custom gates call it at `src/gates/custom.ts:24-65`.

**Implementation vision:** Add an async runner based on `spawn` with the existing shell/cwd/env/output semantics and a bounded output collector equivalent to the current 10 MB buffer. Extend options with an optional `AbortSignal`; distinguish `timed_out` from `cancelled` in the result contract, preserve `exit_code` for a real child exit, and use an explicit non-command-failure detail for timeout/cancellation. On timeout or abort, terminate the spawned shell and its child tree using a platform-aware strategy, wait for close, and resolve exactly once. Keep the synchronous runner only if existing public callers require it; Gate 0 and custom gates must use the new async runner. Do not convert timeout/cancellation into a generic exit-code `-1` failure.

**Files:**
- Modify: `src/executor/runner.ts:15-88`
- Modify: `src/gates/gate0.ts:62-95`
- Modify: `src/gates/custom.ts:24-65`
- Test: `src/executor/__tests__/runner.test.ts`
- Test: `src/gates/__tests__/gate0.test.ts`
- Test: `src/gates/__tests__/custom.test.ts`

**Verification:** `npm run build` passes; `npx vitest run src/executor/__tests__/runner.test.ts src/gates/__tests__/gate0.test.ts src/gates/__tests__/custom.test.ts` passes. New tests prove a short timer fires while a runner command is active, a configured timeout returns `timed_out: true` with timeout-specific detail, an abort returns `cancelled: true`, and ordinary non-zero exits remain ordinary failures.

**Done when:** Gate 0/custom command execution is asynchronous and abortable, process termination is bounded, and timeout/cancellation evidence cannot be mistaken for a test command’s actual exit failure.

---

### Epic 1.2: Timeout-accurate Gate 0 evidence and state transitions

**Goal:** `task_complete` records an unambiguous Gate 0 outcome when a command times out or is interrupted, while retaining enough evidence to diagnose the attempt.
**Scope:** `src/tools/gate.ts`, `src/evidence/manager.ts`, Gate 0 evidence types, gate/evidence tests.
**Dependencies:** Epic 1.1
**Done when:** a timed-out check is shown as a timeout with command, duration, and configured limit; a cancelled check is shown as cancelled; Gate 0 evidence is saved before the task becomes terminal; successful and ordinary failing tasks preserve current completed-task behavior; no result reports `server_tests failed (exit code -1)` for a timeout.
**Status:** Pending

#### Task 1.2.1: Persist explicit gate-attempt outcomes through task completion

- [ ] Done

**Context:** `handleTaskComplete` runs Gate 0 then saves evidence at `src/tools/gate.ts:207-242`, finally transitions the task at `:279-284`. Its textual response at `:286-305` uses the check detail produced by Gate 0. `gate0.ts:84-95` currently treats every non-zero result as `failed (exit code ...)`, even when `runner.ts:78-87` identified a timeout. `EvidenceManager.save` is atomic per file at `src/evidence/manager.ts:72-81`, but no attempt metadata distinguishes execution from a completed result.

**Implementation vision:** Add a versioned Gate 0 attempt representation that records `started_at`, terminal `finished_at`, command-level timeout/cancellation fields, and a terminal outcome (`passed`, `failed`, `timed_out`, or `cancelled`). Save the in-progress attempt before invoking checks, then atomically replace/update it with terminal evidence before changing the task state. Keep existing completed evidence fields (`passed`, `checks`, command, duration) readable by current audit/review code. Timeout or cancellation must transition the task to `failed` only after evidence says why; ordinary command failures remain `failed`; a process exception must create terminal `execution_error` evidence rather than leaving a task permanently `doing`. Do not delete prior evidence during this task.

**Files:**
- Modify: `src/tools/gate.ts:170-305`
- Modify: `src/gates/gate0.ts:62-95`
- Modify: `src/evidence/manager.ts:24-81`
- Test: `src/tools/__tests__/gate.test.ts:352-543`
- Test: `src/evidence/__tests__/manager.test.ts:54-157`

**Verification:** `npm run build` passes; `npx vitest run src/tools/__tests__/gate.test.ts src/evidence/__tests__/manager.test.ts src/gates/__tests__/gate0.test.ts` passes. New task-completion tests assert timeout evidence is saved before `failed`, displays a timeout-specific message rather than exit `-1`, cancellation is distinct, and an injected runner exception produces terminal evidence and no lingering `doing` task.

**Done when:** Every completed, failed, timed-out, cancelled, or execution-error Gate 0 attempt has durable, accurate evidence that matches task state and gives a user actionable recovery information.

---

## Phase 2: Observable In-Flight Gate Attempts

### Epic 2.1: Surface gate execution progress through MCP status and diagnostics

**Goal:** Clients can distinguish a task actively running Gate 0 from a task abandoned in `doing`, and receive current check name, elapsed time, timeout budget, and evidence location without waiting for completion.
**Scope:** state schema, `src/tools/cycle.ts`, `src/tools/recovery.ts`, MCP response formatting, status/diagnostic tests.
**Dependencies:** Phase 1
**Done when:** `cycle_status` and `cycle_diagnose` report a live Gate 0 attempt as executing rather than stuck; elapsed time and configured timeout are visible; a request to status/diagnostics returns while a long gate command runs; completed attempts no longer appear active.
**Status:** Pending

#### Task 2.1.1: Persist and surface live Gate 0 progress

- [ ] Done

**Context:** Gate 0 attempt evidence currently records only start and terminal data, while `cycle_status` reads state alone and `cycle_diagnose` labels every `doing` task as stuck.

**Implementation vision:** Add a stable attempt identity and current-check progress metadata to Gate 0 evidence. Persist progress before each command starts, then make `cycle_status` and `cycle_diagnose` render an executing attempt with its check, elapsed time, configured timeout, and evidence path. Keep completed attempts out of active reporting and retain the existing stuck diagnosis for `doing` tasks without live attempt evidence.

**Files:**
- Modify: `src/evidence/manager.ts`
- Modify: `src/gates/gate0.ts`
- Modify: `src/tools/gate.ts`
- Modify: `src/tools/cycle.ts`
- Modify: `src/tools/recovery.ts`
- Test: `src/evidence/__tests__/manager.test.ts`
- Test: `src/gates/__tests__/gate0.test.ts`
- Test: `src/tools/__tests__/gate.test.ts`
- Test: `src/tools/__tests__/cycle.test.ts`
- Test: `src/tools/__tests__/recovery.test.ts`

**Verification:** `npm run build` passes; `npx vitest run src/evidence/__tests__/manager.test.ts src/gates/__tests__/gate0.test.ts src/tools/__tests__/gate.test.ts src/tools/__tests__/cycle.test.ts src/tools/__tests__/recovery.test.ts` passes.

**Done when:** Status and diagnostics return immediately during a long-running Gate 0 command, report its live progress and timing, and never misclassify it as stuck.

### Epic 2.2: Add explicit gate observation and idempotent completion behavior

**Goal:** A reconnecting MCP client can observe or await the existing task’s gate attempt instead of issuing a duplicate `task_complete`.
**Scope:** MCP gate/cycle tool contracts, attempt identity/state, tool tests, skills/docs.
**Dependencies:** Epic 2.1
**Done when:** a second `task_complete` for an active attempt returns its attempt identity/status without rerunning commands; a completed attempt returns its persisted result; clients have a documented status/polling path; all transitions remain deterministic.
**Status:** Pending

#### Task 2.2.1: Make task completion observable and idempotent

- [ ] Done

**Context:** Concurrent `task_complete` requests each see a `doing` task and run Gate 0 again. Reconnecting clients cannot retrieve a live attempt or a persisted terminal result through the completion contract.

**Implementation vision:** Use the persisted attempt identity and an in-process single-flight registry to ensure a second completion call observes an executing attempt rather than running commands again. Return persisted terminal results idempotently when state and evidence agree. Document polling `cycle_status` for reconnecting clients; new attempts must require the normal retry/start lifecycle.

**Files:**
- Modify: `src/tools/gate.ts`
- Modify: `src/tools/cycle.ts`
- Modify: `skills/cycle/SKILL.md`
- Test: `src/tools/__tests__/gate.test.ts`
- Test: `src/tools/__tests__/cycle.test.ts`

**Verification:** `npm run build` passes; `npx vitest run src/tools/__tests__/gate.test.ts src/tools/__tests__/cycle.test.ts` passes.

**Done when:** Duplicate completion calls do not rerun Gate 0, return attempt status or persisted terminal output, and clients have a documented polling path.

---

## Phase 3: Recovery, Audit, and Historical Evidence

### Epic 3.1: Reconcile interrupted and completed attempts during recovery

**Goal:** Restarted servers and client-disconnected requests recover gate attempts deterministically from persisted attempt/evidence state.
**Scope:** `src/tools/recovery.ts`, state validation, evidence audit, recovery tests.
**Dependencies:** Phase 2
**Done when:** an attempt with a terminal result is reconciled to the matching task status; an attempt left in-progress after server restart is marked interrupted with actionable evidence; diagnosis recommends the minimal safe action and does not misclassify active work as stuck.
**Status:** Pending

#### Task 3.1.1: Classify and reconcile persisted Gate 0 attempts

- [ ] Done

**Implementation vision:** Add a durable attempt classifier for live, interrupted, terminal-recoverable, and inconsistent state/evidence combinations. Reconcile terminal evidence left with a `doing` task to its matching terminal task status; preserve current-process active attempts; mark abandoned persisted attempts as terminal `interrupted` with actionable evidence.

**Files:**
- Modify: `src/evidence/manager.ts`
- Modify: `src/state/validator.ts`
- Modify: `src/tools/recovery.ts`
- Test: `src/evidence/__tests__/manager.test.ts`
- Test: `src/state/__tests__/validator.test.ts`
- Test: `src/tools/__tests__/recovery.test.ts`

**Verification:** `npm run build` passes; `npx vitest run src/evidence/__tests__/manager.test.ts src/state/__tests__/validator.test.ts src/tools/__tests__/recovery.test.ts` passes.

**Done when:** Terminal evidence safely repairs an interrupted task state, abandoned attempts become durable interrupted failures, active attempts are untouched, and re-running reconciliation is idempotent.

#### Task 3.1.2: Surface deterministic recovery outcomes and guidance

- [ ] Done

**Implementation vision:** Integrate reconciliation into diagnostics, retain status as read-only, and produce minimal outcome-specific recovery guidance for interrupted, failed, successful, and inconsistent attempts. Document restart recovery.

**Files:**
- Modify: `src/tools/recovery.ts`
- Modify: `src/tools/cycle.ts`
- Modify: `skills/cycle/SKILL.md`
- Test: `src/tools/__tests__/recovery.test.ts`
- Test: `src/tools/__tests__/cycle.test.ts`

**Verification:** `npm run build` passes; `npx vitest run src/tools/__tests__/recovery.test.ts src/tools/__tests__/cycle.test.ts` passes.

**Done when:** Diagnostics reconcile safely, identify active versus interrupted work, and recommend only the minimum safe action.

### Epic 3.2: Retain and audit failed-attempt history

**Goal:** Retry operations preserve prior failed/timeout/cancelled evidence for debugging while allowing a new attempt to run cleanly.
**Scope:** evidence naming/indexing, `task_manage retry`, evidence cleanup, audit tests, cycle skill documentation.
**Dependencies:** Epic 3.1
**Done when:** retry creates a new attempt without deleting historical terminal evidence; diagnostics can identify the latest attempt and summarize prior outcomes; cleanup removes all known evidence classes consistently, including Gate 1 and custom post-task artifacts.
**Status:** Pending

#### Task 3.2.1: Preserve immutable terminal Gate 0 attempt history

- [ ] Done

**Implementation vision:** Retain each terminal Gate 0 attempt under its attempt ID while keeping the canonical evidence file as the latest compatible projection. Retries clear only current task summary state and never delete previous terminal attempts.

**Files:**
- Modify: `src/evidence/manager.ts`
- Modify: `src/tools/gate.ts`
- Modify: `src/tools/recovery.ts`
- Test: `src/evidence/__tests__/manager.test.ts`
- Test: `src/tools/__tests__/gate.test.ts`
- Test: `src/tools/__tests__/recovery.test.ts`

**Verification:** `npm run build` passes; `npx vitest run src/evidence/__tests__/manager.test.ts src/tools/__tests__/gate.test.ts src/tools/__tests__/recovery.test.ts` passes.

**Done when:** Retry preserves old terminal attempts, creates a fresh attempt for new work, and the canonical evidence remains the latest result.

#### Task 3.2.2: Audit history and remove task evidence exhaustively

- [ ] Done

**Implementation vision:** Add compact latest/prior attempt summaries to diagnostics and manager-owned exhaustive task-evidence cleanup, including Gate 1, post-task custom evidence, and attempt history. Preserve epic-owned review/acceptance evidence.

**Files:**
- Modify: `src/evidence/manager.ts`
- Modify: `src/tools/recovery.ts`
- Modify: `src/archive/manager.ts`
- Modify: `skills/cycle/SKILL.md`
- Test: `src/evidence/__tests__/manager.test.ts`
- Test: `src/tools/__tests__/recovery.test.ts`
- Test: `src/archive/__tests__/manager.test.ts`

**Verification:** `npm run build` passes; `npx vitest run src/evidence/__tests__/manager.test.ts src/tools/__tests__/recovery.test.ts src/archive/__tests__/manager.test.ts` passes.

**Done when:** Diagnostics summarize current/prior outcomes; destructive task cleanup removes all task-scoped evidence and history but never epic evidence; reset and archive handle nested history.

---

## Self-Review

- **Spec coverage:** MCP timeout responsiveness and non-blocking execution are covered by Epic 1.1; accurate `exit_code -1` evidence by Epic 1.2; live status/diagnostics by Epic 2.1; reconnect/idempotent completion by Epic 2.2; automatic reconciliation by Epic 3.1; retry/evidence-history ergonomics and cleanup gaps by Epic 3.2.
- **Vagueness scan:** Phase 1 specifies the runner process model, timeout/cancellation distinctions, evidence ordering, terminal transitions, paths, and test outcomes; no detailed task defers an edge case.
- **Contract consistency:** Phase 1 defines versioned attempt metadata used by Phase 2 observation and Phase 3 reconciliation/history; the existing completed `GateEvidence` fields remain compatible.
- **Phase boundaries:** Phase 1 yields non-blocking, accurate terminal gate execution; Phase 2 yields observable live attempts; Phase 3 yields restart-safe recovery and historical auditability.
- **Verification plausibility:** `npm run build` and `npx vitest run src/` are configured Gate 0 commands in `.rigor/config.yaml:16-19`; Phase 1 focused Vitest paths exist under the named `src/**/__tests__` directories.
