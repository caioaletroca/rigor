---
name: rigor:plan
description: >-
  Write a rolling-wave phased implementation plan from a spec before coding:
  phase-epic-task hierarchy where Phase 1 is detailed into dispatch-ready tasks
  and later phases stay epic-level for elaboration during execution. Reads gate
  thresholds from .rigor/config.yaml so task verification aligns with gate exit
  criteria. Use when a multi-file feature needs decomposition before coding.
  Skip for single-file changes or exploratory spikes.
---

Decompose a spec into a rolling-wave plan: phases with independently verifiable milestones, epics with acceptance criteria, and dispatch-ready tasks in the first phase only.

Write the plan assuming the implementer is skilled but has zero context for the codebase, toolset, or problem domain.

The plan is a **rolling-wave document**. Only the first phase is detailed to task level at plan time; later phases stay at epic level until execution reaches them. Detail decays: code written in Phase 1 invalidates assumptions baked into Phase 3 tasks, so do not write Phase 3 tasks yet. The execution skill elaborates each subsequent phase against the codebase as it actually exists.

**Announce at start:** "Using rigor:plan to author the implementation plan."

**Default save path:** `docs/plans/YYYY-MM-DD-<feature-name>.md`
(User preferences override.)

---

## HARD STOP -- VALIDATE SPEC BEFORE WRITING

Do NOT plan on a shaky foundation. Check for blockers FIRST.

| Situation | Action |
|-----------|--------|
| Vague requirements ("make it better", "add feature") | STOP. Ask: "What specific behavior should change?" |
| Missing success criteria | STOP. Ask: "How do we verify this works?" |
| Unknown codebase structure (can't locate files) | STOP. Explore the codebase first, then plan |
| Conflicting constraints | STOP. Ask: "Which constraint takes priority?" |
| Multiple valid architectures without guidance | STOP. Ask: "Which pattern should we use?" |

---

## Step 0 -- Load Config

Read `.rigor/config.yaml` from the repository root. Extract gate thresholds that affect plan writing:

| Key | Effect on Plan |
|-----|----------------|
| `gates.gate_0.coverage_threshold` | Task verification commands must target this threshold |
| `gates.gate_0.lint_command` | Task verification can reference the configured lint command |
| `gates.gate_0.test_command` | Task verification can reference the configured test command |
| `gates.gate_0.require_test_files` | If `true`, every task creating code MUST list a test file in Files |

If the config file does not exist, proceed with defaults. Do NOT prompt the user to create one.

---

## Step 1 -- Scope Check

If the spec covers multiple independent subsystems, suggest breaking it into separate plans -- one per subsystem. Each plan must produce working, testable software on its own.

If the user already split the spec into sub-project specs, write one plan per sub-spec.

---

## Step 2 -- Write Plan Header

Every plan MUST start with this header:

```markdown
# [Feature Name] Implementation Plan

> **For implementers:** This is a rolling-wave plan. Phase 1 tasks are
> dispatch-ready. Later phases are epic-level only -- elaborate them against
> the real codebase when execution reaches them.
> This document is the living source of truth -- task elaboration for later
> phases is written back into it during execution.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | [what works at the end] | 1.1, 1.2 | Detailed |
| 2 | [what works at the end] | 2.1, 2.2 | Epic-level |
| 3 | [what works at the end] | 3.1 | Epic-level |

---
```

---

## Step 3 -- Write Epics (all phases)

### Epic Format

```markdown
### Epic N.M: [Name]

**Goal:** [what exists and works when this epic is done]
**Scope:** [subsystems/directories touched -- coarse-grained for later phases]
**Dependencies:** [epics or phases that must land first, or "none"]
**Done when:** [observable acceptance criteria]
**Status:** Pending
```

`**Status:**` lifecycle: Pending -> Doing -> Done | Failed. This field is the write target for `rigor:cycle` when it manages execution.

### Plan Hierarchy

| Level | Granularity | When detailed |
|-------|-------------|---------------|
| **Phase** | Independently verifiable milestone -- software works at the end of every phase | At plan time |
| **Epic** | Cohesive unit of work inside a phase (one capability, one subsystem) | At plan time |
| **Task** | Dispatch-ready unit: context + implementation vision + verification | Phase 1 at plan time; later phases during execution (rolling wave) |

Rules:
- Every phase ends with working, testable software. No phase ends mid-refactor.
- 2-5 epics per phase. An epic that needs more than a paragraph to describe is two epics.
- Order phases by dependency first, then by risk -- front-load whatever invalidates the design if it turns out wrong.

### Epic "Done when" and Gate 9

The **Done when** field in each epic is the acceptance criteria that Gate 9 validates. Write it as observable, testable statements -- not vague descriptions. These criteria are mapped to code evidence during acceptance.

---

## Step 4 -- Write Tasks (Phase 1 only)

For Phase 1 epics, write dispatch-ready tasks immediately below each epic block. For later phases, the epic block is the whole entry -- tasks are added during execution.

### Task Format

Each task is close to a ready-to-dispatch prompt: an implementer with zero context should be able to start within a minute of reading it.

```markdown
#### Task N.M.T: [Action-oriented name]

- [ ] Done

**Context:** [why this task exists; what already exists, with `file.ext:42`-style
references into the current codebase]

**Implementation vision:** [the approach; key decisions already made; patterns
to follow or avoid; named edge cases and how each is handled]

**Files:**
- Create: `exact/path/to/file.ext`
- Modify: `exact/path/to/existing.ext:123-145`
- Test: `path/to/file_test.ext`

**Verification:** [command to run + expected outcome]

**Done when:** [acceptance criteria]
```

Use `file:line` references when pointing into existing code. Paths are always exact for every file touched.

### Task Verification and Gate 0

Task verification commands are the Gate 0 exit criteria. They must be real, runnable shell commands with expected outcomes. If `.rigor/config.yaml` defines `test_command` or `lint_command`, verification can reference those configured commands.

---

## No Vague Tasks

The plan's deliverable is **decisions**, not code. A task without decisions is a plan failure:

| Pattern | Why it fails |
|---------|--------------|
| "Add appropriate error handling" | WHICH errors, handled HOW? Decide in the plan. |
| "Handle edge cases" | Name them, one by one. |
| "TBD" / "TODO" / "figure out during implementation" in detailed-wave tasks | The detailed wave admits no deferrals -- that's what makes it dispatch-ready |
| Implementation vision that restates the task name | Vision = approach + decisions, not a paraphrase |
| Task referencing a contract no epic defines | Plan is internally inconsistent |

Deferrals ARE allowed in later-phase epics -- that is the point of rolling wave. They are NOT allowed inside the detailed wave.

---

## Code Snippet Policy

Default is **prose, not code**. Describe intent, decisions, and shape; the implementer writes the code at execution time with the real codebase in front of them.

Include a snippet ONLY when prose cannot pin down the decision:

| Justified | Example |
|-----------|---------|
| Public contract other epics depend on | API signature, event schema, migration DDL |
| Non-obvious algorithm where the approach IS the decision | Custom balancing logic, conflict-resolution rule |
| Exact artifact where approximation breaks behavior | Config block, regex, SQL query |

If the snippet exists to "save the implementer time", delete it. If it exists because two epics would otherwise disagree about a contract, keep it.

---

## Step 5 -- Self-Review

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself -- not a subagent dispatch.

| Check | What to verify |
|-------|----------------|
| **Spec coverage** | Skim each requirement in the spec. Point to an epic that covers it. List gaps. |
| **Vagueness scan** | Search detailed-wave tasks for the red flags in "No Vague Tasks". Fix any matches. |
| **Contract consistency** | Names, signatures, and schemas referenced across epics agree. A contract defined nowhere but used somewhere is a bug. |
| **Phase boundaries** | Every phase ends with working, verifiable software. |
| **Verification plausibility** | Detailed-wave verification commands target real paths and plausible outcomes. |

If you find issues, fix them inline. No need to re-review -- just fix and move on.

---

## Step 6 -- Save and Handoff

Save the plan to `docs/plans/YYYY-MM-DD-<feature-name>.md` (or user-specified path).

After saving, announce the save location and ask the user how they want to proceed:

> Plan complete and saved to `<path>`. How would you like to execute it?
>
> **1. Start execution now** -- begin implementing Phase 1 tasks in this session
>
> **2. Save for later** -- plan is ready; execute in a separate session
>
> **3. Review first** -- walk through the plan before committing to execution

If the user chooses execution and `rigor:cycle` is available, hand off to it. Otherwise, proceed with manual task-by-task implementation in this session.

---

## Verification Checklist

Before marking the plan complete:

- [ ] Plan header present (Goal, Architecture, Tech Stack, Phase Overview)
- [ ] Every phase ends in working, testable software
- [ ] Every epic has Goal, Scope, Dependencies, Done-when, Status
- [ ] Phase 1 epics fully broken into dispatch-ready tasks; later phases epic-level only
- [ ] No vague tasks in the detailed wave (no "appropriate", "TBD", unnamed edge cases)
- [ ] Code snippets only where the Code Snippet Policy justifies them
- [ ] Contract consistency across epics
- [ ] Self-review checklist applied
- [ ] Plan saved to target path
- [ ] Execution handoff offered

---

## Worked Example

<example title="Phase 1 epic with a dispatch-ready task, and a Phase 2 epic left at epic level">
### Epic 1.1: User lookup service path

**Goal:** `GET /users/:id` returns a persisted user end-to-end
**Scope:** `src/service/`, `src/handler/`
**Dependencies:** none
**Done when:** integration test fetches a seeded user by ID; unknown ID returns 404
**Status:** Pending

#### Task 1.1.1: Implement GetUserByID service method

- [ ] Done

**Context:** `UserRepository` interface already exposes `getById` at `src/domain/repository.ts:15`. The service layer (`src/service/user-service.ts`) has no read path yet -- only `create`.

**Implementation vision:** Add `getById(id)` to `UserService`, delegating to the repository. Follow the error-handling pattern used by `create` (`user-service.ts:31-38`): propagate a `NotFoundError` untouched -- the handler layer maps it to 404. No input validation here: ID format is validated at the handler.

**Files:**
- Modify: `src/service/user-service.ts`
- Test: `src/service/user-service.test.ts`

**Verification:** run test suite targeting the get-by-id cases -- found and not-found cases both pass; not-found asserts the error type.

**Done when:** service returns the user for a known ID and a `NotFoundError` for an unknown one, with error handling matching the `create` pattern.

---

### Epic 2.1: User list endpoint with cursor pagination

**Goal:** `GET /users` returns paginated results
**Scope:** `src/service/`, `src/handler/`, repository query layer
**Dependencies:** Epic 1.1 (read path patterns established there)
**Done when:** paginated listing works against seeded data; cursor round-trips; page size capped at 100
**Status:** Pending

*(No tasks yet -- elaborated during execution after Phase 1 lands, against the read-path patterns Phase 1 actually established.)*
</example>

---

## Anti-Patterns (FORBIDDEN)

- Do NOT write tasks for phases beyond Phase 1 -- that is premature detail that decays
- Do NOT plan without checking for blockers first -- a plan on vague requirements wastes effort
- Do NOT use vague language in detailed-wave tasks -- "appropriate", "handle edge cases", "TBD" are plan failures
- Do NOT include code snippets to save the implementer time -- only for contracts and decisions
- Do NOT skip the self-review -- it catches spec gaps and inconsistencies before execution
- Do NOT hardcode language-specific commands in task verification -- reference config values or use generic descriptions
- Do NOT create a plan for a single-file change -- just do it
- Do NOT write tasks without `file:line` references into the existing codebase -- the implementer has zero context
- Do NOT set Status to anything other than "Pending" at plan time -- execution updates status
- Do NOT skip the scope check -- multi-subsystem plans should be split

---

## Anti-Rationalization Table

| Rationalization | Why It Is WRONG | Required Action |
|-----------------|-----------------|-----------------|
| "I will detail Phase 2 tasks now since I know the design" | You know the design NOW, before Phase 1 code exists. Phase 1 changes invalidate Phase 2 assumptions. Rolling wave exists for this reason. | **MUST leave later phases at epic level only** |
| "This task is clear enough without file references" | Zero-context implementer cannot locate the code. "Clear enough" = clear to you, opaque to them. | **MUST include `file:line` references for existing code** |
| "I will add a code snippet to help the implementer" | Snippets written against current code go stale during execution. Only contracts between epics justify a snippet. | **Apply Code Snippet Policy -- delete if it is for convenience** |
| "The verification is obvious so I will skip it" | Gate 0 needs a runnable command. "Obvious" verification = no verification. | **MUST write verification command + expected outcome** |
| "This requirement is implied by another epic" | Implied requirements get lost. If it is in the spec, an epic must cover it explicitly. | **MUST map every spec requirement to an epic in self-review** |
| "I will add TBD for this edge case and figure it out later" | TBD in the detailed wave means the task is not dispatch-ready. Deferrals belong in later-phase epics only. | **MUST decide in the plan or move to a later phase** |
| "One big phase is simpler than splitting" | A single mega-phase has no intermediate verification point. If something is wrong, you discover it at the end. | **MUST split into phases with independently verifiable milestones** |
| "The spec is a bit vague but I can infer the intent" | Inferred intent becomes a plan decision the spec author never approved. | **STOP and ask for clarification** |
