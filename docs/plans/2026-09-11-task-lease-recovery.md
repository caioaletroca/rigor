# Task Lease Recovery and Safe Takeover Implementation Plan

> **For implementers:** This is a rolling-wave plan. Phase 1 tasks are dispatch-ready. Later phases remain epic-level until execution reaches them.

**Goal:** Ensure interrupted Rigor task sessions do not leave work unnecessarily locked while preserving concurrent ownership guarantees and complete attempt history.

**Architecture:** Extend the existing per-task lease and attempt journal with explicit liveness/recovery classification. A task owned by an active session remains protected; an owner that disconnects or whose lease exceeds the documented stale threshold becomes recoverable through an auditable takeover or retry transition. Recovery preserves every prior attempt and never permits two active owners simultaneously.

**Tech Stack:** TypeScript, Node.js, MCP SDK, Vitest, JSON state/evidence, process/session lifecycle handling.

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | Lease ownership and stale-session recovery are deterministic and testable | 1.1, 1.2 | Detailed |
| 2 | Session disconnects and explicit takeovers are safely reconciled | 2.1 | Epic-level |
| 3 | Documentation and multi-agent integration validation are complete | 3.1 | Epic-level |

---

## Phase 1: Lease Recovery Foundations

### Epic 1.1: Detect abandoned task ownership

**Goal:** Rigor distinguishes active leases from abandoned leases without weakening protection for live agents.

**Scope:** task state schema, lease manager/state manager, task lifecycle tools, recovery diagnostics.

**Dependencies:** none

**Done when:** ownership includes lease expiry and last activity; active leases reject conflicting operations; expired leases are classified as stale; recovery is idempotent and preserves attempt history.

**Status:** Pending

#### Task 1.1.1: Add lease liveness and stale classification

- [ ] Done

**Implementation vision:** Record owner ID, attempt ID, lease expiry, and last heartbeat/activity timestamp in task state. Define one configured stale threshold and classify ownership as active or stale using server time. Ensure reads do not mutate state and concurrent state updates remain atomic.

**Verification:** Run build and focused lease/state tests. Prove active leases remain protected, expired leases become stale, clock-boundary behavior is deterministic, and prior attempts remain unchanged.

#### Task 1.1.2: Reconcile stale leases through recovery

- [ ] Done

**Implementation vision:** Extend cycle diagnostics and task lifecycle management to reconcile stale `doing` tasks into an explicit interrupted/failed recovery state. Preserve the abandoned attempt record, make repeated diagnosis idempotent, and return an actionable retry or takeover recommendation.

**Verification:** Run build and recovery tests. Prove restart/disconnect-style stale tasks are recoverable, active tasks are untouched, reconciliation is idempotent, and historical evidence is retained.

### Epic 1.2: Safe task takeover semantics

**Goal:** A replacement agent can recover a task only when the prior owner is no longer active, with clear ownership transitions.

**Scope:** task start/complete/retry/management schemas and handlers, attempt journal, concurrency tests.

**Dependencies:** Epic 1.1

**Done when:** takeover requires explicit intent, active-owner takeover is rejected, stale-owner takeover atomically issues a new attempt/lease, and old ownership cannot complete the replacement attempt.

**Status:** Pending

#### Task 1.2.1: Add explicit stale-owner takeover

- [ ] Done

**Implementation vision:** Add a takeover option to task start or management operations. Validate the target task and stored project context, reject takeover of a live lease, transition stale ownership to interrupted, and issue a fresh owner/attempt identity atomically. Keep normal retry semantics separate from takeover.

**Verification:** Run build and focused concurrency tests. Prove explicit takeover is required, live-owner takeover fails, stale takeover succeeds, old attempt completion is rejected, and new evidence identifies the replacement owner.

#### Task 1.2.2: Test competing owners and interrupted sessions

- [ ] Done

**Implementation vision:** Add integration coverage for simultaneous starts, owner disconnect/restart, stale threshold expiry, takeover races, duplicate recovery, and preserved nested attempt history.

**Verification:** Run the full test suite and multi-project/multi-agent integration tests.

---

## Phase 2: Session Disconnect and Recovery Integration

### Epic 2.1: Reconcile client and server lifecycle events

**Goal:** MCP disconnects and server restarts leave tasks recoverable without waiting unnecessarily or corrupting ownership.

**Scope:** MCP/session lifecycle hooks, recovery service, persisted attempt journal, diagnostics responses.

**Dependencies:** Phase 1

**Done when:** explicit disconnect signals release or mark leases according to policy; unexpected termination is recovered by stale reconciliation; diagnostics expose active, stale, interrupted, and failed states with actionable next steps.

**Status:** Pending

---

## Phase 3: Documentation and Validation

### Epic 3.1: Document operational recovery behavior

**Goal:** Agents and operators understand lease duration, disconnect handling, takeover requirements, and evidence preservation.

**Scope:** cycle skill, recovery documentation, release notes, end-to-end validation.

**Dependencies:** Phase 2

**Done when:** the workflow documents safe recovery and tests validate the user-reported stopped-session scenario without manual state edits or unsafe bypasses.

**Status:** Pending
