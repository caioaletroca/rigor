# Automatic Completed-Cycle Archival Implementation Plan

> **For implementers:** This is a rolling-wave plan. Phase 1 tasks are
> dispatch-ready. Later phases are epic-level only -- elaborate them against
> the real codebase when execution reaches them.
> This document is the living source of truth -- task elaboration for later
> phases is written back into it during execution.

**Goal:** Automatically preserve completed cycle state and evidence in history while immediately unblocking the next cycle.

**Architecture:** Add a filesystem archive operation that snapshots `.rigor/state.json` and the complete active evidence directory under `.rigor/history/`, validates the snapshot, and only then clears active runtime artifacts. Invoke it exclusively after the final phase transitions to `done`; errors retain the active cycle intact so a retry is safe.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Vitest, JSON state/evidence.

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | Final phase completion archives every cycle artifact safely and permits immediate cycle initialization | 1.1, 1.2 | Detailed |

---

## Phase 1: Safe Automatic Completed-Cycle Archival

### Epic 1.1: Validated cycle archive primitive

**Goal:** A completed cycle's active state and all evidence can be copied to a unique, self-contained history snapshot without risking data loss.
**Scope:** `src/state/`, `src/evidence/`, archive tests.
**Dependencies:** none
**Done when:** An archive contains readable state plus every active evidence file; its identifier cannot overwrite an existing archive; copy or validation failure leaves active state/evidence untouched; archive output contains no transient `.tmp` files.
**Status:** Pending

#### Task 1.1.1: Add an archive manager with copy-before-cleanup semantics

- [ ] Done

**Context:** `StateManager` owns `.rigor/state.json` and atomic state writes at `src/state/manager.ts:42-103`; `EvidenceManager` owns the flat `.rigor/evidence/` directory at `src/evidence/manager.ts:53-81`. `clearAll` deletes every direct evidence entry at `src/evidence/manager.ts:140-150`, so archival must enumerate actual evidence files rather than assume only Gate 0/8/9 names.

**Implementation vision:** Introduce one focused archive abstraction rooted at `.rigor/history/`. It receives the loaded terminal `CycleState`, derives a collision-free archive directory from the cycle ID and completion timestamp, copies `state.json` and all regular files in active evidence to staging, then validates by parsing the copied state and comparing the copied file set to the source set. Publish the archive by atomically renaming the staging directory only after validation. Never remove any active artifact in this task; ignore or reject `.tmp` and non-file entries deliberately so an interrupted runtime write cannot become archived evidence. Return the absolute archive path and copied evidence count.

**Files:**
- Create: `src/archive/manager.ts`
- Test: `src/archive/__tests__/manager.test.ts`
- Modify: `src/state/manager.ts:8-16,42-103` only if narrowly needed to expose active state paths through a manager-owned API
- Modify: `src/evidence/manager.ts:8-17,53-150` only if narrowly needed to expose active evidence paths/listing through a manager-owned API

**Verification:** `npm run build` passes; `npx vitest run src/archive/__tests__/manager.test.ts src/state/__tests__/manager.test.ts src/evidence/__tests__/manager.test.ts` passes.

**Done when:** archive tests prove successful state/evidence snapshotting, distinct archive paths for collisions, ignored temporary files, and unchanged active artifacts after injected copy or validation failures.

---

### Epic 1.2: Final-phase archival and next-cycle availability

**Goal:** The final `phase_advance` archives a successfully completed cycle, clears only active runtime artifacts after archival success, and reports the archive location.
**Scope:** `src/tools/review.ts`, state/evidence cleanup integration, cycle/review tests, README and cycle skill documentation.
**Dependencies:** Epic 1.1
**Done when:** Final phase advancement returns a history path and leaves no active cycle; `cycle_init` succeeds immediately afterward; non-final advancement behavior is unchanged; an archive failure keeps the completed active state/evidence available and returns actionable failure output.
**Status:** Pending

#### Task 1.2.1: Finalize completed cycles through the archive primitive

- [ ] Done

**Context:** `handlePhaseAdvance` marks the phase done at `src/tools/review.ts:504-511`, advances normally if another phase exists at `:513-536`, and currently only reports completion for the final phase at `:539-544`. `handleCycleInit` allows a new cycle exactly when `StateManager.load()` returns null at `src/tools/cycle.ts:128-140`. `cycle_reset` shows the established active-artifact cleanup behavior at `src/tools/recovery.ts:91-114`, but must remain destructive and separate from successful completion.

**Implementation vision:** Inject the archive dependency into the phase-advance handler and tool registration. On the no-next-phase branch, archive the already-terminal state, then remove active state and active evidence only after the archive reports validated success. Preserve the archive if active cleanup reports a failure and return an error describing the remaining active artifact; never claim a cycle is finished unless the active state no longer blocks initialization. Do not invoke archival for intermediate phases, incomplete epics, or repeated calls with no active cycle. Include the archive path in success output and retain the existing completion wording.

**Files:**
- Modify: `src/tools/review.ts:464-616`
- Modify: `src/tools/__tests__/review.test.ts:678-717`
- Modify: `src/tools/__tests__/cycle.test.ts` 
- Modify: `README.md:339-341`
- Modify: `skills/cycle/SKILL.md:182-190`

**Verification:** `npm run build` passes; `npx vitest run src/archive/__tests__/manager.test.ts src/tools/__tests__/review.test.ts src/tools/__tests__/cycle.test.ts` passes; `npx vitest run src/` passes.

**Done when:** integration tests prove final completion archives state and all evidence, a new cycle initializes without reset, intermediate progression does not archive, and an injected archive failure retains active state/evidence with a clear error.

---

## Self-Review

- **Spec coverage:** Snapshot-before-cleanup and archive validation are Epic 1.1; automatic final-phase triggering, active-artifact cleanup, and immediate next-cycle initialization are Epic 1.2; history documentation is included in Task 1.2.1.
- **Vagueness scan:** Detailed tasks name source locations, file operations, failure behavior, and commands; no implementation deferrals remain in Phase 1.
- **Contract consistency:** Archive publication precedes all active cleanup; finalization uses the archive result before reporting success.
- **Phase boundaries:** Phase 1 ends with complete automatic archival and verifiable next-cycle availability.
- **Verification plausibility:** `.rigor/config.yaml` configures `npm run build` and `npx vitest run src/`; all named test directories already exist or are created by the detailed task.
