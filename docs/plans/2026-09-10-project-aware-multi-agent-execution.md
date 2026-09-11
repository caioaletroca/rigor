# Project-Aware Multi-Agent Execution Implementation Plan

> **For implementers:** This is a rolling-wave plan. Phase 1 tasks are
> dispatch-ready. Later phases are epic-level only -- elaborate them against
> the real codebase when execution reaches them.
> This document is the living source of truth -- task elaboration for later
> phases is written back into it during execution.

**Goal:** Make Rigor plug-and-play across multiple projects and concurrent agents by resolving project context per cycle/request, isolating state, preventing conflicting task attempts, and preserving actionable gate diagnostics.

**Architecture:** Replace the process-global project-root assumption with a canonical per-project `ProjectContext`/cycle registry keyed by absolute Git root. Tool calls resolve context from an explicit root or plan path first and use the server default only as fallback; state, evidence, locks, and subprocess cwd are always derived from that context. Gate execution remains asynchronous and persists an attempt journal, with command output and timeout/cancellation metadata captured for reconciliation. Per-task leases and attempt IDs prevent concurrent agents from overwriting or completing one another’s work.

**Tech Stack:** TypeScript, Node.js, MCP SDK, Vitest, child-process execution, JSON state/evidence, Git root discovery.

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | Every tool resolves and reports an isolated project context, and gate attempts carry accurate diagnostics | 1.1, 1.2 | Detailed |
| 2 | Multiple projects and agents can use one Rigor server without state collisions | 2.1, 2.2 | Epic-level |
| 3 | Concurrent task ownership and interrupted work recover safely | 3.1, 3.2 | Epic-level |
| 4 | Documentation, client configuration, migration, and integration validation are complete | 4.1, 4.2 | Epic-level |

---

## Phase 1: Project Context and Gate Attempt Foundations

### Epic 1.1: Resolve project context per request

**Goal:** Rigor can operate on a project without requiring an MCP/session restart, and every relevant tool uses the same canonical root for state, evidence, plan parsing, and subprocess execution.
**Scope:** `src/server.ts`, `src/cli.ts`, `src/tools/cycle.ts`, tool registration/context plumbing, project-root utilities, context tests.
**Dependencies:** none
**Done when:** an absolute plan path inside a Git repository selects that repository root even when the server default is different; an explicit project root overrides fallback resolution; relative paths resolve against the request/default context; no-repository paths fail or use the documented fallback with a warning; status/task/recovery/review tools resolve the active cycle’s stored root rather than a stale process-global root; responses include canonical `project_root` and cycle identity.
**Status:** Pending

#### Task 1.1.1: Add canonical project-root discovery and request context

- [ ] Done

**Context:** `src/server.ts:45-74` constructs one `StateManager` and `EvidenceManager` from the process-level `--project-root`, while `src/tools/cycle.ts:69-110` and `:128-199` resolve plan paths independently. The known mismatch causes `cycle_init`/`cycle_reload` to write one root while `cycle_status`/`task_*` read another. Tool handlers in `src/tools/cycle.ts:282-362`, `src/tools/gate.ts:170-306`, and `src/tools/recovery.ts:699-872` receive managers tied to that global root.

**Implementation vision:** Create a canonical resolver that accepts optional explicit `project_root`, `plan_path`, and server fallback root. Normalize absolute paths, discover the nearest Git top-level using a bounded parent walk or the existing command executor, and return `{ project_root, source, warning }`. Add a request/cycle context registry keyed by canonical root; contexts own `StateManager`, `EvidenceManager`, and config loading, while preserving the server fallback for backward-compatible calls. Store the resolved root in cycle state at initialization and make task/gate/review/recovery handlers select the context from that stored root. Add `project_root` and `cycle_id` to structured tool responses without breaking existing human-readable lines. Relative paths must never be interpreted against an arbitrary process cwd after a cycle has been loaded.

**Files:**
- Create: `src/context/project-context.ts`
- Create: `src/context/project-root.ts`
- Modify: `src/server.ts:45-74`
- Modify: `src/cli.ts:20-40`
- Modify: `src/tools/cycle.ts:69-199,282-362`
- Modify: `src/tools/gate.ts:170-306`
- Modify: `src/tools/recovery.ts:699-872`
- Test: `src/context/__tests__/project-root.test.ts`
- Test: `src/tools/__tests__/cycle.test.ts`
- Test: `src/tools/__tests__/gate.test.ts`

**Verification:** Run `npm run build` and `npx vitest run src/context/__tests__/project-root.test.ts src/tools/__tests__/cycle.test.ts src/tools/__tests__/gate.test.ts`. Tests prove absolute-plan Git-root selection, explicit-root precedence, relative/no-repository fallback warnings, stored-cycle-root reuse, and response context fields.

**Done when:** Project root is resolved from request/cycle context rather than only process startup, with deterministic fallback behavior and no session restart requirement.

#### Task 1.1.2: Make state/evidence/config access context-isolated

- [ ] Done

**Context:** `src/state/manager.ts` and `src/evidence/manager.ts` construct paths from a root supplied at creation; `src/config/loader.ts:62` loads Gate 0 config from the selected project. Existing tool handlers retain manager instances passed during registration, so multiple roots cannot safely share one MCP process.

**Implementation vision:** Replace long-lived single-root manager capture with context lookup at handler execution. Cache one context per canonical root, invalidate its config only when requested or when the config file changes, and never share `StateManager`/`EvidenceManager` between roots. Persist the canonical root in cycle state and reject operations when the requested root conflicts with the active task’s stored root. Preserve atomic state/evidence writes and ensure context creation never creates another project’s `.rigor` directory merely for a read-only status call. Add tests that initialize two temporary Git repositories through one tool registry and assert isolated state, evidence, config, and task progress.

**Files:**
- Modify: `src/context/project-context.ts`
- Modify: `src/state/manager.ts:1-80`
- Modify: `src/evidence/manager.ts:53-150`
- Modify: `src/config/loader.ts:1-90`
- Modify: `src/tools/cycle.ts:282-362`
- Modify: `src/tools/gate.ts:170-306`
- Modify: `src/tools/recovery.ts:699-872`
- Test: `src/context/__tests__/project-context.test.ts`
- Test: `src/tools/__tests__/cycle.test.ts`

**Verification:** Run `npm run build` and `npx vitest run src/context/__tests__/project-context.test.ts src/tools/__tests__/cycle.test.ts`. A one-process two-project test must show each project’s state/evidence/config remains independent and status calls never read the other project.

**Done when:** Two simultaneous project contexts use one Rigor process without state/evidence/config collisions or cross-project reads.

---

### Epic 1.2: Accurate, observable gate attempt execution

**Goal:** Gate commands report real timeout/cancellation/process outcomes and preserve command output sufficient to diagnose failures from an MCP response or later recovery.
**Scope:** `src/executor/runner.ts`, `src/gates/gate0.ts`, `src/gates/custom.ts`, `src/tools/gate.ts`, evidence schemas/manager, runner/gate tests.
**Dependencies:** Epic 1.1
**Done when:** gate commands do not block unrelated MCP handlers; timeout and cancellation are distinct from ordinary exit failure; evidence includes bounded stdout/stderr, command duration, configured timeout, termination reason, and attempt identity; task state transitions match terminal evidence; output is redacted or capped according to documented limits.
**Status:** Pending

#### Task 1.2.1: Persist command-level diagnostics and attempt identity

- [ ] Done

**Context:** `src/executor/runner.ts:15-22` exposes only command, exit code, output, duration, and `timed_out`; `:66-87` currently derives timeout from `spawnSync` and maps it to exit code `-1`. Gate 0 formats all non-zero outcomes generically at `src/gates/gate0.ts:84-95`, and `handleTaskComplete` persists evidence only after all checks at `src/tools/gate.ts:207-242`.

**Implementation vision:** Extend the async runner result with attempt ID, started/finished timestamps, configured timeout, termination reason (`exit`, `timeout`, `cancelled`, `spawn_error`, `output_limit`), signal/exit details, and bounded stdout/stderr lengths plus truncation flags. Persist a gate-attempt record before the first command and update it after each check so a crash identifies the last check. Format timeout/cancellation/spawn errors explicitly and retain ordinary exit-code semantics. Redact known secret-like environment/argument values before evidence persistence without altering command execution. Add deterministic tests for output truncation, process timeout, cancellation, spawn failure, and exact evidence fields.

**Files:**
- Modify: `src/executor/runner.ts:15-88`
- Modify: `src/gates/gate0.ts:42-185`
- Modify: `src/gates/custom.ts:24-65`
- Modify: `src/tools/gate.ts:207-305`
- Modify: `src/evidence/manager.ts:24-81`
- Test: `src/executor/__tests__/runner.test.ts`
- Test: `src/gates/__tests__/gate0.test.ts`
- Test: `src/tools/__tests__/gate.test.ts`
- Test: `src/evidence/__tests__/manager.test.ts`

**Verification:** Run `npm run build` and `npx vitest run src/executor/__tests__/runner.test.ts src/gates/__tests__/gate0.test.ts src/tools/__tests__/gate.test.ts src/evidence/__tests__/manager.test.ts`. Tests assert timeout-specific/cancellation-specific details, bounded captured output, redaction, and terminal attempt evidence.

**Done when:** A failed gate response and its evidence distinguish real command failures from timeout, cancellation, spawn, and output-limit failures with enough diagnostics to act.

---

## Phase 2: Multi-Project Server and Client Isolation

### Epic 2.1: Concurrent project operation registry

**Goal:** One long-running Rigor MCP server safely serves multiple projects and cycles concurrently.
**Scope:** context registry, MCP tool schemas, cycle lookup, config/evidence/state managers, integration tests.
**Dependencies:** Phase 1
**Done when:** requests for different canonical roots run concurrently without manager mutation or cross-project responses; each project can have independent active cycles; project context appears in every lifecycle/gate response; invalid context selection fails closed.
**Status:** Pending

#### Task 2.1.1: Route concurrent lifecycle operations through isolated project contexts

- [ ] Done

**Context:** Phase 1 introduced canonical project contexts, but several lifecycle tools and response schemas still rely on captured default-root dependencies.

**Implementation vision:** Complete request-time context routing for cycle, gate, review, recovery, and sync operations. Add explicit context selection to tool schemas, validate canonical roots, and ensure concurrent requests cannot mutate or read another project's managers. Include project root and cycle identity in structured responses.

**Verification:** Run `npm run build` and focused multi-project integration tests, then the full test suite.

#### Task 2.1.2: Add concurrent multi-project isolation integration coverage

- [ ] Done

**Context:** Unit tests do not prove two independent active cycles can progress through one server instance concurrently.

**Implementation vision:** Create temporary Git repositories and initialize independent cycles through one tool registry. Exercise status, task, gate, evidence, and recovery operations concurrently and assert no cross-project state, evidence, config, or subprocess cwd leakage.

**Verification:** Run `npm run build` and the new integration tests plus the full test suite.

### Epic 2.2: Client/session compatibility and migration

**Goal:** Existing clients using only `--project-root` continue working while clients can opt into per-request roots without restarting sessions.
**Scope:** CLI flags, MCP schemas, compatibility adapters, client documentation, migration tests.
**Dependencies:** Epic 2.1
**Done when:** legacy single-root invocation behaves as before; explicit per-request root/plan parameters are documented and validated; server restart is not required to switch projects; ambiguous relative paths produce actionable errors.
**Status:** Pending

#### Task 2.2.1: Preserve legacy CLI behavior and add explicit request context schemas

- [ ] Done

**Context:** Phase 2.1 adds per-request project routing, while existing clients still rely on the server's `--project-root` fallback.

**Implementation vision:** Validate and document explicit project-root and plan-path precedence, preserve legacy single-root calls, and make ambiguous relative paths return actionable errors without requiring a server restart.

**Verification:** Run `npm run build` and focused CLI/tool schema compatibility tests, then the full test suite.

#### Task 2.2.2: Add client migration and multi-session compatibility coverage

- [ ] Done

**Context:** Compatibility behavior must be proven across legacy fallback and explicit per-request project selection.

**Implementation vision:** Add integration coverage for switching projects in one server session, legacy calls using the configured root, invalid and ambiguous relative paths, and structured context fields in lifecycle responses.

**Verification:** Run `npm run build` and the compatibility integration tests plus the full test suite.

---

## Phase 3: Concurrent-Agent Ownership and Recovery

### Epic 3.1: Per-task leases and attempt ownership

**Goal:** Multiple agents operating in one project cannot overwrite or complete each other’s active task attempts.
**Scope:** state schema, task start/complete/retry/management tools, lease storage, tool schemas, concurrency tests.
**Dependencies:** Phase 2
**Done when:** task starts issue owner/attempt IDs with expiry; a different owner cannot complete/reset/retry an active attempt without explicit takeover; stale leases are recoverable; simultaneous starts are serialized; evidence records owner and attempt identity.
**Status:** Pending

#### Task 3.1.1: Add per-task leases and attempt ownership

- [ ] Done

**Context:** Multiple agents can currently start or complete the same task through one project context without durable ownership.

**Implementation vision:** Extend task state and tool schemas with owner and attempt identity, issue expiring leases atomically, reject conflicting completion/retry/reset operations, and support explicit takeover of stale leases. Persist ownership in evidence and expose it in lifecycle responses.

**Verification:** Run `npm run build` and focused lease/concurrency tests, then the full test suite.

#### Task 3.1.2: Serialize task operations and recover stale leases

- [ ] Done

**Context:** Per-root state isolation does not by itself prevent concurrent read-modify-write races within one project.

**Implementation vision:** Serialize task mutations per project, make simultaneous starts deterministic, implement stale-lease recovery, and add integration tests for competing owners and takeover behavior.

**Verification:** Run `npm run build` and concurrency/recovery tests plus the full test suite.

### Epic 3.2: Interrupted-attempt reconciliation and history

**Goal:** Process crashes, MCP disconnects, and client restarts reconcile in-progress attempts without erasing historical failures.
**Scope:** recovery diagnostics, evidence indexing/archive, retry semantics, state validator, cycle skill documentation.
**Dependencies:** Epic 3.1
**Done when:** terminal attempts are reconciled idempotently; in-progress attempts become explicitly interrupted after a documented threshold; retry creates a new attempt while preserving prior evidence; diagnosis distinguishes active, stale, interrupted, and failed work.
**Status:** Pending

#### Task 3.2.1: Reconcile interrupted attempts and preserve history

- [ ] Done

**Context:** Process restarts and client disconnects can leave in-progress gate attempts without a durable, actionable terminal classification.

**Implementation vision:** Extend diagnostics and evidence indexing to distinguish active, stale, interrupted, and failed attempts; reconcile terminal attempts idempotently; preserve prior evidence when retrying.

**Verification:** Run `npm run build` and focused recovery/history tests, then the full test suite.

#### Task 3.2.2: Document retry and interruption recovery semantics

- [ ] Done

**Context:** Operators and cycle automation need deterministic guidance for interrupted work and historical attempts.

**Implementation vision:** Update cycle/recovery skill guidance and add tests for retry-created attempt history, stale interruption thresholds, and recovery recommendations.

**Verification:** Run `npm run build` and recovery integration tests plus the full test suite.

---

## Phase 4: Operational Hardening and Integration Validation

### Epic 4.1: Diagnostics, observability, and safe failure UX

**Goal:** Operators can understand project context, active attempts, command progress, failures, timeouts, and recovery recommendations from MCP responses and logs without secret leakage.
**Scope:** response schemas, structured logging, evidence audit, docs, integration fixtures.
**Dependencies:** Phase 3
**Done when:** every diagnostic includes project root/cycle/task/attempt identity where applicable; command output is bounded/redacted; timeout and cancellation recommendations are actionable; no cross-project or stale-context claims remain.
**Status:** Pending

### Epic 4.2: Cross-client and multi-project acceptance validation

**Goal:** Rigor is validated under simultaneous OpenCode/Claude/Hermes-style clients and multiple project roots.
**Scope:** integration harness, MCP transport tests, fixture repositories, release checklist.
**Dependencies:** Epic 4.1
**Done when:** two projects and multiple agents can initialize cycles, run gates, inspect status, recover interrupted attempts, and complete independent tasks without collisions; compatibility and performance budgets are documented.
**Status:** Pending

---

## Self-Review

- **Spec coverage:** Plug-and-play root resolution is Epic 1.1; gate timeout/output accuracy is Epic 1.2; multi-project one-process isolation is Phase 2; concurrent-agent ownership is Phase 3; operational diagnostics and cross-client acceptance are Phase 4.
- **Vagueness scan:** Phase 1 tasks specify resolver precedence, fallback behavior, manager isolation, diagnostic fields, termination reasons, output limits, redaction, test fixtures, and commands; no detailed task defers named edge cases.
- **Contract consistency:** `ProjectContext` is the shared key for state/evidence/config/subprocess cwd; cycle state stores its canonical root; gate attempts store attempt identity and command diagnostics; later leases/evidence reuse these identities.
- **Phase boundaries:** Phase 1 yields independently usable context resolution and accurate terminal evidence; Phase 2 yields multi-project compatibility; Phase 3 yields concurrent-agent recovery; Phase 4 validates operational behavior across clients.
- **Verification plausibility:** `.rigor/config.yaml:16-20` configures `npm run build` and `npx vitest run src/`; detailed tasks use those commands plus focused existing test paths.
