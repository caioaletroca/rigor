# Rigor Dogfood Fixes Implementation Plan

> **For implementers:** This is a rolling-wave plan. Phase 1 tasks are
> dispatch-ready. Later phases are epic-level only -- elaborate them against
> the real codebase when execution reaches them.
> This document is the living source of truth -- task elaboration for later
> phases is written back into it during execution.

**Goal:** Fix four accumulated Rigor dogfood findings so the gate server and its docs behave correctly for multi-project, Python-first usage.

**Architecture:** Four small, independent corrections in the Rigor codebase (gates matcher, Gate 9 schema validation and docs, Gate 0 task lifecycle docs, and cycle project-root resolution). Each lands in one subsystem and is verified against the repo's real Gate 0 (`npm run build` + `npx vitest run src/`). No cross-epic contract changes.

**Tech Stack:** TypeScript, MCP SDK, vitest, Zod (already present).

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | All four dogfood corrections implemented and green | 1.1, 1.2, 1.3, 1.4 | Detailed |

---

## Epic 1.1: Accept pytest-style `test_<name>.py` source/test pairing

**Goal:** `require_test_files` recognizes the pytest convention `test_<name>.py` in addition to today's `<name>_test.py` and `<name>.test.ts` / `<name>.spec.ts`, so new Python source + `tests/test_foo.py` is a valid pairing.
**Scope:** `src/gates/gate0.ts`, `src/gates/__tests__/gate0.test.ts`
**Dependencies:** none
**Done when:** with a new source file `src/foo.py`, a `tests/test_foo.py` in the same changeset satisfies the `test_files` check (passes); a missing test file still fails. Existing `<name>.test|spec.ts` and `<name>_test.py` pairings continue to pass.
**Status:** Pending

#### Task 1.1.1: Extend `isTestPath`/`testStem` to recognize `test_<name>` prefix convention

- [ ] Done

**Context:** `src/gates/gate0.ts:200-206` (`isTestPath`) and `:216-222` (`testStem`) currently only strip the suffix markers `.test`, `.spec`, and `_test`. A pytest-style file `tests/test_foo.py` is therefore NOT detected as a test file, so a new `src/foo.py` paired with `tests/test_foo.py` fails the `require_test_files` check in `evaluateTestFiles` (`:230-284`).

**Implementation vision:** Add a `test_` **prefix** marker alongside the existing suffix markers. In `isTestPath`, recognize base names matching `^test_.*\.(py|...)` (reuse `SOURCE_EXT`). In `testStem`, strip a leading `test_` from the base **before** stripping `SOURCE_EXT`, so `tests/test_foo.py` -> stem `foo` matching `src/foo.py` -> stem `foo`. Keep the existing suffix logic intact (do not break `.test.ts`, `.spec.ts`, `_test.py`). Only strip the prefix once at the start; a source file literally named `test_something.py` is still a valid stem source when it is NOT in a test path. Prefer a small helper, e.g. `testPrefix` regex `^test_`, applied only inside the two functions.

**Files:**
- Modify: `src/gates/gate0.ts:200-222`
- Test: `src/gates/__tests__/gate0.test.ts`

**Verification:** `npm run build` passes; `npx vitest run src/gates/__tests__/gate0.test.ts` passes including new cases.

**Done when:** a RED test asserting `evaluateTestFiles` passes with `src/foo.py` + `tests/test_foo.py` (and fails without the test) turns GREEN; existing suffix-marker cases still covered by the suite.

---

## Epic 1.2: Return a schema error when Gate 9 `criteria` JSON is malformed or `met` is missing

**Goal:** `accept_submit` validates the parsed `criteria` array structurally (array, non-empty, each item has string `criterion`, string `evidence`, boolean `met`) and returns a clear error instead of silently treating a missing `met` as `false`.
**Scope:** `src/tools/review.ts` (and optionally `src/gates/gate9.ts`), `src/tools/__tests__/review.test.ts`
**Dependencies:** none
**Done when:** submitting criteria where any item lacks `met` (or `criterion`/`evidence`) returns an explicit validation error and does NOT write evidence; a correctly-shaped array passes Gate 9 as before. Existing passing criteria still pass.
**Status:** Pending

#### Task 1.2.1: Validate Gate 9 criteria payload before evaluation

- [ ] Done

**Context:** `src/tools/review.ts` `handleAcceptSubmit` parses `params.criteria` with a bare `JSON.parse` + `as AcceptanceCriterion[]` cast (`:328-337`), then passes it to `checkGate9Exit` (`src/gates/gate9.ts:41`). Because runtime validation is absent, an object `{ criterion, evidence }` (no `met`) becomes `met: undefined`, which `criteria.filter((c) => c.met)` at `gate9.ts:52` treats as unmet -- a silent, unactionable failure rather than a schema error.

**Implementation vision:** After the `JSON.parse` at `review.ts:331`, validate the result with a Zod schema (`z.array(z.object({ criterion: z.string(), evidence: z.string(), met: z.boolean() })).min(1)`). Zod is already a dependency (imported across `src/tools/*.ts`). On validation failure, return `textResult("Invalid criteria JSON: <zod error>", true)` without saving evidence or mutating state -- short-circuit before `checkGate9Exit`. Move the minimal per-item shape contract into `src/gates/gate9.ts` as a `Gate9Criteria` type/const so `gate9.ts` and `review.ts` agree; `checkGate9Exit` may keep `<criterion>.met` access since the array is now known-valid at the call site. Do not change the `met: boolean` semantics (missing must be a schema error, not coalesced).

**Files:**
- Modify: `src/tools/review.ts:328-337`
- Modify: `src/gates/gate9.ts:15-19`
- Test: `src/tools/__tests__/review.test.ts`

**Verification:** `npx vitest run src/tools/__tests__/review.test.ts` passes with new malformed-criteria cases asserting an `isError` result and no evidence file written.

**Done when:** a RED test submitting `[{ criterion: "x", evidence: "y" }]` (no `met`) gets an explicit error instead of a Gate 9 fail; and a missing-but-passing array (`[]`) also errors as `min(1)` non-empty.

---

## Epic 1.3: Fix `rigor:cycle` doc to match real post-Gate-0 task lifecycle

**Goal:** The `skills/cycle/SKILL.md` post-Gate-0 retry guidance matches the implementation: a `task_complete` that fails Gate 0 moves the task to `failed`, and retrying requires `task_start` (not a second bare `task_complete`).
**Scope:** `skills/cycle/SKILL.md`
**Dependencies:** none
**Done when:** the doc no longer tells the reader to keep the task in `doing` and re-call `task_complete`; it states the task becomes `failed` and that `task_start` restarts it (retry path). No code behavior changes.
**Status:** Pending

#### Task 1.3.1: Correct the Gate 0 failure/retry paragraph in skills/cycle

- [ ] Done

**Context:** `skills/cycle/SKILL.md:105` currently reads: "If Gate 0 fails: Read the evidence. Fix the failing check. Call `task_complete` again (the task stays in 'doing' so you can retry without calling `task_start`)." This contradicts the implementation: `src/tools/gate.ts:279-284` transitions the task to `failed` on Gate 0 failure, and `src/state/schema.ts:31-34` only allows `failed -> doing` via `task_start` (entry criteria at `gate.ts:74-81` are `pending|failed`). So the task does NOT stay in `doing`, and `task_complete` on a `failed` task is rejected.

**Implementation vision:** Rewrite `skills/cycle/SKILL.md:105` (the "If Gate 0 fails" paragraph) to state the actual flow: the task transitions to `failed`; inspect the evidence, fix the failing check, then call `task_start({ task_id })` again -- whose entry criteria accept a `failed` task -- to move it back to `doing` and retry. Keep the "never fabricate evidence" warning from `:19` adjacent/consistent. This is a docs-only change; no `src/` edits.

**Files:**
- Modify: `skills/cycle/SKILL.md:105`

**Verification:** `grep -n "task_complete again" skills/cycle/SKILL.md` returns no matches; `grep -n "stays in .doing"` returns no matches; the paragraph references `task_start` for retry.

**Done when:** the paragraph describes `failed` -> fix -> `task_start` retry, and the old misleading "stays in doing / call task_complete again" text is gone.

---

## Epic 1.4: Derive cycle project root from the absolute plan path when possible

**Goal:** `cycle_init` (and `cycle_reload`) resolve the project root from an absolute `plan_path` when one is given, so the correct `.rigor/` state/evidence directory is used even if the MCP server's `--project-root` was misconfigured or omitted. The explicit server `projectRoot` remains the authoritative root; plan-derived root applies only when it is the sole reliable signal.
**Scope:** `src/tools/cycle.ts`, `src/server.ts` (doc/config notes), `src/tools/__tests__/cycle.test.ts`
**Dependencies:** none
**Done when:** given an absolute `plan_path` inside a git repo whose root differs from the server's `projectRoot`, `cycle_init` targets the git-root `.rigor/` (documented, with a fallback and warning); relative `plan_path` behavior is unchanged. No existing absolute-plan behavior is broken.
**Status:** Pending

#### Task 1.4.1: Resolve project root from the absolute plan path in cycle_init/reload

- [ ] Done

**Context:** `src/tools/cycle.ts` `handleCycleInit` (`:69-110`) and `handleCycleReload` (`:128-199`) receive `plan_path`, resolve it to an absolute path, and call `stateManager.init(resolvedPath, ...)` -- but `StateManager` (and its `.rigor/` state path) is constructed once in `src/server.ts` from the server-level `projectRoot` (passed from `--project-root` at `src/cli.ts:30` or cwd). If the server was started with the wrong `--project-root` (a known dogfood recurrence), state/evidence land in the wrong directory.

**Implementation vision:** Add a small helper in `src/tools/cycle.ts`, e.g. `resolveProjectRoot(planPath, serverRoot)` that treats the absolute `plan_path`'s directory as the anchor and resolves its git top-level (via scanning upward for `.git`/`.git/` dirs, or `git rev-parse --show-toplevel` using the existing `runCommand` from `src/executor`); returns the git root when found, else `serverRoot`. Because `StateManager` is constructed once per server with the server's root, the decision is: `cycle_init`/`cycle_reload` compute the effective root and, when it differs from the server root, **build a fresh cycle-scoped `StateManager(effectiveRoot)`** (and matching `EvidenceManager(effectiveRoot)`) just for the init/reload call, writing state/evidence under the derived root. Keep `cycle_status`/`cycle_reset`/`task_*` reading the **server root's** state so a misconfigured server root is surfaced (a warning in the init response) rather than silently hidden. When the derived root equals `serverRoot` or no repo is found, use `serverRoot` unchanged. Document the fallback in `skills/cycle/SKILL.md` Step 1 (`:67-69`).

**Files:**
- Modify: `src/tools/cycle.ts:69-110, 128-199`
- Modify: `skills/cycle/SKILL.md:67-69`
- Test: `src/tools/__tests__/cycle.test.ts`

**Verification:** `npx vitest run src/tools/__tests__/cycle.test.ts` passes including a new case that points an absolute `plan_path` at a temp git root differing from the server root and asserts `.rigor/state.json` is created under the git root (and a warning is returned).

**Done when:** a RED test (absolute plan path in a different git root) turns GREEN with state created under the derived git root; relative-plan and no-repo fallbacks remain green and surfaced via warning.

---
