# Extended Recovery Tools Implementation Plan

> **For implementers:** This is a rolling-wave plan. Phase 1 tasks are
> dispatch-ready. Later phases are epic-level only -- elaborate them against
> the real codebase when execution reaches them.
> This document is the living source of truth -- task elaboration for later
> phases is written back into it during execution.

**Goal:** Extend the Rigor MCP server with granular state management tools (`task_manage`, `epic_manage`, `phase_manage`) that let agents recover from stuck states, skip work, and force status changes -- all with user confirmation via a preview/confirm pattern.

**Architecture:** Extend the existing recovery tool group in `src/tools/recovery.ts`. Add `skipped` as a new first-class status to the state machine. Rename `task_retry` to `task_manage` with action-based dispatch. Add `epic_manage` and `phase_manage` as new tools. Enhance `cycle_diagnose` with structured fix suggestions. Add a `delete()` method to `EvidenceManager` to replace inline `unlinkSync` calls.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk, Zod, Vitest

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | State machine supports `skipped` status + `forceTransition`; `EvidenceManager` has `delete()` | 1.1, 1.2 | Detailed |
| 2 | All three manage tools registered and working (`task_manage`, `epic_manage`, `phase_manage`) | 2.1, 2.2 | Epic-level |
| 3 | Enhanced `cycle_diagnose` with structured suggestions; all references updated | 3.1, 3.2 | Epic-level |

---

## Phase 1: Foundation -- State Machine + Evidence Cleanup

### Epic 1.1: Add `skipped` status and force transitions to state machine

**Goal:** The `Status` type includes `skipped`, `VALID_TRANSITIONS` includes `skipped` edges, and `StateManager` has a `forceTransition()` method that bypasses the transition map.
**Scope:** `src/state/schema.ts`, `src/state/manager.ts`, `src/state/validator.ts`
**Dependencies:** none
**Done when:**
- `Status` type is `"pending" | "doing" | "done" | "failed" | "skipped"`
- `isValidTransition` handles `skipped` (any status can transition to `skipped`)
- `StateManager.forceTransition(entityId, toStatus)` sets status regardless of current status
- `validateState` and `detectStuckEntities` treat `skipped` entities correctly (not flagged as stuck, not counted as errors)
- All existing tests still pass; new tests cover `skipped` status and force transitions
**Status:** Pending

#### Task 1.1.1: Add `skipped` to Status type and transition map

- [ ] Done

**Context:** `Status` is defined at `src/state/schema.ts:12` as a union of 4 string literals. `VALID_TRANSITIONS` is a `ReadonlyMap` at `schema.ts:22-27` that defines the directed graph. `isValidTransition` at `schema.ts:32-36` checks the map. The `done` status is currently terminal -- no outgoing edges.

**Implementation vision:** Add `"skipped"` to the `Status` union. Add a transition edge from every existing status to `"skipped"` in `VALID_TRANSITIONS` -- meaning `pending|doing|done|failed -> skipped` are all valid. Do NOT add outgoing edges from `skipped` (force transition handles un-skipping; the normal transition map should not allow `skipped -> doing`). Update the JSDoc comment above `VALID_TRANSITIONS` to document the new edges.

**Files:**
- Modify: `src/state/schema.ts:12` (Status type)
- Modify: `src/state/schema.ts:22-27` (VALID_TRANSITIONS)
- Test: `src/state/__tests__/manager.test.ts` (transition tests for skipped)

**Verification:** `npx vitest run src/state` -- all existing tests pass, new tests confirm `pending->skipped`, `doing->skipped`, `done->skipped`, `failed->skipped` are valid, and `skipped->doing` is invalid via normal transition.

**Done when:** `isValidTransition("done", "skipped")` returns `true`; `isValidTransition("skipped", "doing")` returns `false`.

---

#### Task 1.1.2: Add `forceTransition` method to StateManager

- [ ] Done

**Context:** `StateManager.transition()` at `src/state/manager.ts:137-155` is the only status mutation path. It calls `isValidTransition` and throws `InvalidTransitionError` if the transition is not allowed. Recovery tools need to bypass this -- e.g., moving a `done` task back to `pending`.

**Implementation vision:** Add a `forceTransition(entityId: string, toStatus: Status): CycleState` method to `StateManager`. It follows the same pattern as `transition()` (load state, find entity via `findEntity`, mutate status, save) but skips the `isValidTransition` check. It should validate that `toStatus` is a valid `Status` value (not arbitrary strings) but not enforce the transition graph. Place it right after the existing `transition()` method for locality.

**Files:**
- Modify: `src/state/manager.ts:155` (add method after `transition`)
- Test: `src/state/__tests__/manager.test.ts`

**Verification:** `npx vitest run src/state` -- new tests confirm `forceTransition("1.1.1", "pending")` works from any status including `done` and `skipped`.

**Done when:** `forceTransition` can set any entity to any valid `Status` regardless of current status; throws `EntityNotFoundError` for unknown ids; does not throw `InvalidTransitionError`.

---

#### Task 1.1.3: Update validator to handle `skipped` status

- [ ] Done

**Context:** `validateState` at `src/state/validator.ts:53-203` checks for valid statuses (lines 91-93, 115-117, 174-176), consistency between done status and gate passage (lines 140-151, 188-193), and evidence paths. `detectStuckEntities` at `validator.ts:215-245` flags entities in `doing` status. Neither function knows about `skipped`.

**Implementation vision:** In `validateState`: add `"skipped"` to the set of valid status values checked at lines 91-93, 115-117, 174-176. For consistency checks: `skipped` entities should NOT be flagged for missing gate evidence (a skipped task has no gate_0 to pass). In `detectStuckEntities`: `skipped` entities should NOT be flagged as stuck (they are intentionally inactive). No other changes needed -- `skipped` is a quiescent state that should be invisible to validation.

**Files:**
- Modify: `src/state/validator.ts:53-203` (validateState valid status checks)
- Modify: `src/state/validator.ts:215-245` (detectStuckEntities)
- Test: `src/state/__tests__/validator.test.ts`

**Verification:** `npx vitest run src/state` -- new tests confirm: a state with `skipped` tasks/epics validates as `healthy`; `skipped` entities are not detected as stuck; `skipped` done entities don't trigger missing-evidence warnings.

**Done when:** A cycle state containing `skipped` entities at any level (task, epic, phase) passes validation without errors or warnings.

---

### Epic 1.2: Add `delete` method to EvidenceManager

**Goal:** `EvidenceManager` has a `delete(gate, entityId)` method and a `deleteAll(entityId)` method. Inline `unlinkSync` calls in recovery tools are replaced.
**Scope:** `src/evidence/manager.ts`, `src/tools/recovery.ts` (refactor existing inline deletion)
**Dependencies:** none
**Done when:**
- `evidenceManager.delete("gate_0", "1.1.1")` deletes the evidence file if it exists, returns boolean
- `evidenceManager.deleteAll("1.1.1")` deletes all evidence files for an entity (gate_0, gate_8, gate_9)
- Existing `handleTaskRetry` and `handleCycleReset` use the new methods instead of raw `unlinkSync`
- All existing tests still pass
**Status:** Pending

#### Task 1.2.1: Add `delete` and `deleteAll` methods to EvidenceManager

- [ ] Done

**Context:** `EvidenceManager` at `src/evidence/manager.ts:49-96` has `save()` (line 68) and `load()` (line 85) but no deletion capability. The file naming pattern is `${gate}-task-${entityId}.json` (line 70). Deletion is currently done inline: `handleTaskRetry` uses `unlinkSync` at `recovery.ts:164-166`, and `handleCycleReset` iterates all files in the evidence dir at `recovery.ts:97-101`.

**Implementation vision:** Add two methods to `EvidenceManager`:
- `delete(gate: string, entityId: string): boolean` -- builds the filename using the same pattern as `save`/`load`, calls `unlinkSync` if the file exists, returns `true` if deleted. Follows the same error-handling style as `load` (check existence first, no throw on missing).
- `deleteAll(entityId: string): number` -- deletes evidence for all known gates (`gate_0`, `gate_8`, `gate_9`) for a given entity id. Returns count of files deleted. Uses the `delete` method internally.

Place both methods after `load()` for locality.

**Files:**
- Modify: `src/evidence/manager.ts:95` (add methods after `load`)
- Test: `src/evidence/__tests__/manager.test.ts`

**Verification:** `npx vitest run src/evidence` -- new tests confirm: `delete` removes existing file and returns `true`; `delete` returns `false` for non-existent file; `deleteAll` removes all gate evidence for an entity.

**Done when:** `EvidenceManager` exposes `delete()` and `deleteAll()` methods that correctly clean up evidence files.

---

#### Task 1.2.2: Refactor existing recovery tools to use EvidenceManager.delete

- [ ] Done

**Context:** `handleTaskRetry` at `recovery.ts:164-166` does inline `unlinkSync` to delete gate_0 evidence. `handleCycleReset` at `recovery.ts:97-101` iterates all files in the evidence directory with `readdirSync` + `unlinkSync`. Both should use the new `EvidenceManager` methods.

**Implementation vision:** In `handleTaskRetry`: replace the `unlinkSync` block at lines 164-166 with `evidenceManager.delete("gate_0", params.task_id)`. The `existsSync` guard is no longer needed since `delete()` handles missing files. In `handleCycleReset`: this one is trickier since it deletes ALL evidence files regardless of entity. Keep the `readdirSync` + `unlinkSync` pattern here since `deleteAll` is per-entity and `cycle_reset` nukes everything. Alternatively, add a `clearAll()` method to `EvidenceManager` that deletes all files in the evidence directory. Either approach is acceptable -- choose whichever keeps the code simpler.

Also remove the `unlinkSync` import from `recovery.ts` line 9 if it is no longer used directly (it may still be needed for `handleCycleReset` depending on approach).

**Files:**
- Modify: `src/tools/recovery.ts:164-166` (handleTaskRetry deletion)
- Modify: `src/tools/recovery.ts:97-101` (handleCycleReset deletion, if adding clearAll)
- Modify: `src/evidence/manager.ts` (add clearAll if chosen)
- Test: `src/tools/__tests__/recovery.test.ts` (existing tests should still pass)

**Verification:** `npx vitest run src/tools` -- all existing recovery tests pass with no behavior change.

**Done when:** No raw `unlinkSync` calls remain in `recovery.ts`; all file deletion goes through `EvidenceManager`.

---

## Phase 2: Management Tools -- task_manage, epic_manage, phase_manage

### Epic 2.1: Implement `task_manage` tool (replaces `task_retry`)

**Goal:** The MCP tool `task_manage` is registered and handles 4 actions: `force_status`, `skip`, `retry`, `reset_evidence`. The old `task_retry` tool is removed. All actions use the preview/confirm pattern.
**Scope:** `src/tools/recovery.ts`, `src/tools/__tests__/recovery.test.ts`, `src/server.ts`
**Dependencies:** Epic 1.1 (forceTransition, skipped status), Epic 1.2 (EvidenceManager.delete)
**Done when:**
- `task_manage` with `action: "force_status"` sets any task to any status with evidence cleanup on backward transitions (preview first, confirm to apply)
- `task_manage` with `action: "skip"` transitions task to `skipped` (preview/confirm)
- `task_manage` with `action: "retry"` preserves current `task_retry` behavior (clear gate_0 evidence for failed tasks)
- `task_manage` with `action: "reset_evidence"` deletes evidence without changing status (preview/confirm)
- `task_retry` tool name is removed from registration; `task_manage` is registered in its place
- Tests cover all 4 actions including preview mode and edge cases
**Status:** Pending

### Epic 2.2: Implement `epic_manage` and `phase_manage` tools

**Goal:** Two new MCP tools registered: `epic_manage` (actions: `force_status`, `reset_tasks`, `skip`) and `phase_manage` (actions: `force_status`, `skip`). Both use preview/confirm pattern.
**Scope:** `src/tools/recovery.ts`, `src/tools/__tests__/recovery.test.ts`, `src/server.ts`
**Dependencies:** Epic 2.1 (follows same action-dispatch pattern)
**Done when:**
- `epic_manage` with `action: "force_status"` sets epic to any status with optional cascade to child tasks
- `epic_manage` with `action: "reset_tasks"` resets all tasks in an epic to `pending`, clearing their evidence
- `epic_manage` with `action: "skip"` transitions epic (and optionally its tasks) to `skipped`
- `phase_manage` with `action: "force_status"` sets phase to any status
- `phase_manage` with `action: "skip"` transitions phase and all child epics/tasks to `skipped`
- All actions use preview/confirm pattern
- Tests cover all actions, cascade behavior, and edge cases
**Status:** Pending

---

## Phase 3: Enhanced Diagnostics + Reference Updates

### Epic 3.1: Enhance `cycle_diagnose` with structured suggestions

**Goal:** `cycle_diagnose` returns structured fix suggestions that reference the new management tools by name and params, enabling the agent to act directly on suggestions.
**Scope:** `src/tools/recovery.ts` (handleCycleDiagnose), `src/tools/__tests__/recovery.test.ts`
**Dependencies:** Epic 2.1, Epic 2.2 (suggestions reference the new tool names)
**Done when:**
- Stuck tasks suggest `task_manage` with `action: "force_status"` or `action: "retry"` depending on current status
- Stuck epics suggest `epic_manage` with `action: "force_status"`
- Stuck phases suggest `phase_manage` with `action: "force_status"`
- Missing evidence suggests `task_manage` with `action: "reset_evidence"`
- Suggestions are formatted as actionable text (tool name + params) not just vague advice
- Progress calculations exclude `skipped` entities from totals
**Status:** Pending

### Epic 3.2: Update all references from `task_retry` to `task_manage`

**Goal:** All SKILL.md files, documentation, and code comments that reference `task_retry` are updated to `task_manage`.
**Scope:** `skills/cycle/SKILL.md`, `docs/`, `src/tools/recovery.ts` (module-level JSDoc), `src/tools/index.ts` (re-exports)
**Dependencies:** Epic 2.1 (task_manage exists)
**Done when:**
- `skills/cycle/SKILL.md` references `task_manage` instead of `task_retry`
- `src/tools/recovery.ts` module-level JSDoc comment (line 2) lists the new tool names
- `src/tools/index.ts` re-exports match the new handler function names
- No remaining references to `task_retry` anywhere in the codebase (verified by grep)
**Status:** Pending
