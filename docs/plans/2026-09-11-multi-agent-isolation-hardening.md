# Multi-Agent Isolation and Runtime Hardening Implementation Plan

> **For implementers:** This is a rolling-wave plan. Phase 1 tasks are
> dispatch-ready. Later phases are epic-level only -- elaborate them against the
> real codebase when execution reaches them.
> This document is the living source of truth -- task elaboration for later
> phases is written back into it during execution.

**Goal:** Make Rigor safe and predictable for an army of agents working the same repository in parallel, each in its own worktree on its own feature branch, and close the runtime correctness gaps found in the 2026-09-11 architecture review.

**Architecture:** Isolation is enforced at the workspace boundary rather than by cross-process locking. Each agent gets a dedicated Git worktree with its own ignored `.rigor/` directory, so two agents never share `state.json` or evidence. `cycle_init` becomes the enforcement point: it refuses a detached HEAD, a base/shared branch, or a worktree that already owns a different cycle, and directs the agent to `rigor:worktree`. Branch creation asks the user for the base branch through the host's formal question mechanism. Inside a single worktree, the existing lease and mutation-queue machinery remains the concurrency control, extended to cover the lifecycle operations that currently bypass it.

**Tech Stack:** TypeScript, Node.js 22, MCP SDK, Vitest, JSON state/evidence, Git worktrees, GitHub Actions.

**Explicitly out of scope:** The project-selection/repository-config execution boundary (arbitrary `project_root` plus shell-bearing `.rigor/config.yaml`). The user has accepted this as harness and operator responsibility. No task in this plan restricts root selection or sandboxes gate commands.

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | An agent cannot start a cycle outside an isolated worktree branch, and worktree/branch setup is guided | 1.1, 1.2 | Detailed |
| 2 | Lifecycle mutations inside a worktree are serialized, fenced, and recoverable | 2.1, 2.2 | Epic-level |
| 3 | Sync, Gate 1, and release provenance stop reporting false success | 3.1, 3.2 | Epic-level |
| 4 | Tool modules are thin adapters over lifecycle services, and docs match runtime | 4.1, 4.2 | Epic-level |

---

## Phase 1: Worktree and Branch Isolation

### Epic 1.1: Enforce isolated workspace at cycle start

**Goal:** `cycle_init` refuses to anchor a cycle in a workspace that would let two agents collide, and the refusal tells the agent exactly how to recover.

**Scope:** `src/tools/cycle.ts`, `src/context.ts`, a new workspace inspection module under `src/workspace/`, `src/tools/__tests__/`.

**Dependencies:** none

**Done when:** initializing a cycle from a detached HEAD is rejected; initializing from a configured base branch is rejected; initializing in a worktree whose `.rigor/state.json` already belongs to a different plan is rejected; each rejection names the offending condition and points at `rigor:worktree`; initializing from a feature branch in a dedicated worktree succeeds unchanged.

**Status:** Pending

#### Task 1.1.1: Add workspace inspection primitives

- [ ] Done

**Context:** Root resolution today answers "which git root" but never "what kind of checkout is this" -- `resolveProjectRoot` at `src/context.ts:36-86` only checks that a `.git` marker exists. `cycle_init` at `src/tools/cycle.ts:97-161` then initializes state with no branch or worktree awareness. `.rigor/state.json` and `.rigor/evidence/` are gitignored (`.gitignore:7-12`), which is what makes per-worktree isolation viable: each worktree already gets its own untracked state.

**Implementation vision:** Create `src/workspace/inspect.ts` exporting `inspectWorkspace(projectRoot)` returning `{ branch: string | null, detached: boolean, is_linked_worktree: boolean, main_worktree_root: string }`. Derive branch from `git rev-parse --abbrev-ref HEAD` (value `HEAD` means detached, so report `detached: true` and `branch: null`). Derive worktree identity from `git rev-parse --git-common-dir` compared against `git rev-parse --git-dir`: when they differ the checkout is a linked worktree; the main worktree root is the parent of the common dir. Use the existing `runCommand` executor (`src/executor/runner.ts`) so timeout and output-cap behavior is inherited rather than reimplemented with raw `child_process`.

Edge cases and their handling, each decided here:
- Git binary missing or the command exits non-zero: throw `WorkspaceInspectionError` carrying the stderr. Callers decide policy; this module never guesses.
- Bare repository (`git rev-parse --is-bare-repository` returns `true`): throw `WorkspaceInspectionError` -- a cycle cannot run in a bare repo.
- Detached HEAD: `branch` is `null`, `detached` is `true`. Not an error at this layer.
- Main worktree (not linked): `is_linked_worktree` is `false`, `main_worktree_root` equals the resolved root. Not an error at this layer.

**Files:**
- Create: `src/workspace/inspect.ts`
- Create: `src/workspace/index.ts`
- Create: `src/workspace/__tests__/inspect.test.ts`

**Verification:** `npx vitest run src/workspace/` passes with cases covering: feature branch in a linked worktree, detached HEAD, main worktree, and git-command failure. Then `npm run build`.

**Done when:** `inspectWorkspace` reports branch, detached state, and linked-worktree status for a real temporary Git repository and a real linked worktree, and throws a typed error when Git is unavailable or the repo is bare.

#### Task 1.1.2: Add isolation policy to config

- [ ] Done

**Context:** Gate and review policy already live in `RigorConfig` (`src/config/schema.ts:12-125`) with defaults at `src/config/schema.ts:154-180`, merged by the loader at `src/config/loader.ts:261-308`. There is no workspace or branch policy today. Config is interface-typed and cast, not runtime-validated -- do not add a validation framework in this task; that belongs to Phase 4.

**Implementation vision:** Add an optional `workspace` section to `RigorConfig`:

```yaml
workspace:
  require_worktree: true
  require_feature_branch: true
  base_branches: [main, master, develop, release]
  allow_override: false
```

`base_branches` is the list of branches a cycle may NOT be initialized on -- they are integration targets, not agent workspaces. `allow_override` gates the escape hatch consumed in Task 1.1.3. Defaults go in `DEFAULTS` at `src/config/schema.ts:154`. Because the loader deep-merges, a project that sets only `base_branches` keeps the other defaults; verify this explicitly rather than assuming, since array merge semantics decide whether a user list replaces or appends. Decision: arrays replace wholesale, matching how `gates.gate_0.checks` already behaves.

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/config/__tests__/loader.test.ts`

**Verification:** `npx vitest run src/config/` passes with a case asserting defaults when no `workspace` key exists, and a case asserting a user-supplied `base_branches` replaces the default list.

**Done when:** `loadConfig` returns the documented workspace defaults for a project with no `workspace` config, and honors partial overrides without dropping sibling defaults.

#### Task 1.1.3: Block cycle_init outside an isolated worktree branch

- [ ] Done

**Context:** `handleCycleInit` at `src/tools/cycle.ts:97-161` resolves the effective root, checks only for an existing cycle (`src/tools/cycle.ts:121-127`), parses the plan, and initializes state. It has no config parameter today -- the registrar passes `config` into `registerCycleTools` (`src/server.ts:69`) and cycle handlers receive it, so the wiring exists at `src/tools/cycle.ts:396-454`.

**Implementation vision:** Before the existing-cycle check, call `inspectWorkspace(effectiveRoot)` and evaluate against `config.workspace`. Reject with a non-error-free `textResult(..., true)` when:
- `detached` is `true` -- message: cycle cannot be anchored to a detached HEAD.
- `require_feature_branch` and `branch` is in `base_branches` -- message names the branch and states it is an integration branch.
- `require_worktree` and `is_linked_worktree` is `false` -- message states the cycle must run in a dedicated worktree.

Every rejection message must include the remediation line: run `rigor:worktree` to create an isolated worktree and feature branch, then re-run `cycle_init` from it. This is what converts a hard stop into a recoverable step for an autonomous agent.

Escape hatch: accept an optional `allow_shared_workspace?: boolean` parameter on `CycleInitParams`. Honor it only when `config.workspace.allow_override` is `true`; otherwise reject and say the override is disabled by project config. This keeps the quick-fix path available without making it the silent default.

When `WorkspaceInspectionError` is thrown (no Git, bare repo), reject with that message rather than proceeding -- fail closed, matching the reasoning used for Gate 1 in Phase 3.

Registration at `src/tools/cycle.ts:396-454` gains the new optional boolean in the Zod schema.

**Files:**
- Modify: `src/tools/cycle.ts`
- Modify: `src/tools/__tests__/cycle.test.ts`

**Verification:** `npx vitest run src/tools/__tests__/cycle.test.ts` passes with cases for: detached HEAD rejected, base branch rejected, non-worktree rejected, feature branch in worktree accepted, override accepted only when `allow_override` is true. Then `npm run build` and `npm test`.

**Done when:** `cycle_init` refuses all three unsafe workspace shapes with actionable messages, accepts an isolated feature-branch worktree unchanged, and honors the override only when project config enables it.

#### Task 1.1.4: Detect foreign cycles already owned by the worktree

- [x] Done

**Context:** `cycle_init` rejects any pre-existing cycle with a single generic message at `src/tools/cycle.ts:121-127`: "A cycle already exists. Use cycle_reset to start over." For a lone agent that is fine. For an agent army it is dangerous advice -- `cycle_reset` deletes state and evidence (`src/tools/recovery.ts:121-127`), so an agent told to reset may destroy a different agent's in-flight cycle if two agents ever share a checkout.

**Implementation vision:** When `sm.load()` returns a state, compare `existing.plan_path` against the resolved plan path. Two distinct outcomes instead of one:
- Same plan: keep current behavior and message. The agent is re-initializing its own cycle.
- Different plan: reject with a message naming the existing `cycle_id` and `plan_path`, and state that this worktree already belongs to another cycle. Do NOT recommend `cycle_reset` in this branch; recommend a separate worktree via `rigor:worktree`. Recommending a destructive command against another agent's state is the specific failure this task exists to prevent.

Compare canonicalized absolute paths so a relative-vs-absolute plan reference does not read as a foreign cycle.

**Files:**
- Modify: `src/tools/cycle.ts`
- Modify: `src/tools/__tests__/cycle.test.ts`

**Verification:** `npx vitest run src/tools/__tests__/cycle.test.ts` passes with a same-plan case (existing message, mentions `cycle_reset`) and a foreign-plan case (names both cycles, does not mention `cycle_reset`).

**Done when:** re-initializing the same plan keeps today's guidance, and initializing a different plan over an existing cycle is refused with a message that names the incumbent cycle and never suggests deleting it.

### Epic 1.2: Guide worktree and branch creation

**Goal:** An agent that hits the Epic 1.1 guardrail can create a compliant worktree and branch, with the base branch chosen by the user rather than assumed.

**Scope:** `skills/worktree/SKILL.md` (new), `skills/cycle/SKILL.md`, `skills/init/SKILL.md`, `docs/naming-conventions.md`.

**Dependencies:** Epic 1.1

**Done when:** a `rigor:worktree` skill exists and is cataloged; it asks for the base branch through the host's formal question mechanism offering detected candidates plus custom entry; it creates one worktree per agent on a new feature branch with a collision-free name; `rigor:cycle` points at it as the mandatory precondition and explains the Epic 1.1 rejections.

**Status:** Pending

#### Task 1.2.1: Author the rigor:worktree skill

- [ ] Done

**Context:** `skills/cycle/SKILL.md:23` already declares `rigor:worktree` mandatory for planned and multi-agent work, but `skills/worktree/` does not exist -- the directory listing shows no such skill, so the reference dangles. A worktree skill description exists in the installed skill catalog but not in this repository. Sibling skills to mirror for structure: `skills/commit/SKILL.md` (config loading, formal questions, verification) and `skills/pr/SKILL.md` (base branch detection with three probes at `skills/pr/SKILL.md:28-51`).

**Implementation vision:** Write a workflow skill that, in order:
1. Detects whether the current checkout is already a compliant worktree; if so, stop and say so rather than nesting worktrees.
2. Determines candidate base branches by probing the remote: `git ls-remote --heads origin` filtered to the `workspace.base_branches` list from config, plus the GitHub default branch. Present the intersection.
3. Asks the user for the base branch through the host's formal question mechanism -- in OpenCode the `question` tool -- with options ordered by detection confidence: the GitHub default branch first marked "(Recommended)", then other detected candidates such as `develop` and `release`, relying on the host's built-in custom-answer affordance for anything else. Never assume a base branch silently; this is the decision the user asked to own.
4. Derives the worktree directory and branch name, incorporating an agent identifier so two agents never collide. Branch naming follows the repo's existing convention (`feat/<slug>`); worktree path defaults to `worktrees/<agent>-<slug>` matching the existing `worktrees/` layout visible in `git worktree list`.
5. Creates the worktree with a new branch off the chosen base: `git worktree add -b <branch> <path> <base>`. Never create a detached worktree -- Epic 1.1 rejects it.
6. Verifies `.rigor/` artifacts are gitignored so the new worktree gets isolated state, installs dependencies, and runs the project's Gate 0 command as a baseline.
7. Reports the worktree path, branch, and base, and instructs the agent to run `cycle_init` from inside the new worktree.

Include an anti-rationalization table. Seed it with the failure modes this plan exists to prevent: assuming `main` without asking, reusing one worktree for two agents, creating a detached worktree, and recommending `cycle_reset` when blocked.

**Files:**
- Create: `skills/worktree/SKILL.md`
- Modify: `docs/naming-conventions.md`

**Verification:** The skill file has valid frontmatter with `name: rigor:worktree`, contains a formal-question step for base branch selection, and a step creating a named branch. `docs/naming-conventions.md` lists the skill in the Current Catalog table with status `Draft`.

**Done when:** `rigor:worktree` exists, is cataloged, asks the user for the base branch with detected defaults, and produces a per-agent worktree on a new feature branch that satisfies the Epic 1.1 guardrail.

#### Task 1.2.2: Wire the worktree precondition into the cycle skill

- [ ] Done

**Context:** `skills/cycle/SKILL.md:23` states the worktree requirement in one line with no recovery procedure. Once Epic 1.1 lands, `cycle_init` returns structured rejections that an agent must know how to act on; the skill is where that mapping belongs.

**Implementation vision:** Expand the workspace step in `skills/cycle/SKILL.md` into a precondition block that runs before `cycle_init`: verify the checkout is a linked worktree on a non-base feature branch, and hand off to `rigor:worktree` when it is not. Add a short table mapping each `cycle_init` rejection -- detached HEAD, base branch, not a worktree, foreign cycle -- to its remediation, so an autonomous agent does not improvise. State explicitly that a foreign-cycle rejection is never resolved with `cycle_reset`. Add a matching row to the skill's anti-rationalization table for "I will just run the cycle here, the worktree is a formality."

**Files:**
- Modify: `skills/cycle/SKILL.md`

**Verification:** `skills/cycle/SKILL.md` contains a precondition block naming `rigor:worktree`, a rejection-to-remediation table covering all four Epic 1.1 rejections, and an anti-rationalization row about skipping worktree isolation.

**Done when:** an agent reading `rigor:cycle` knows how to satisfy the workspace guardrail before calling `cycle_init` and how to recover from each rejection without destroying another agent's state.

---

## Phase 2: Lifecycle Serialization and Lease Fencing

### Epic 2.1: Serialize all state-mutating operations

**Goal:** Every lifecycle tool that mutates `.rigor` state participates in one mutation coordinator, so concurrent calls within a worktree cannot overwrite each other.

**Scope:** `src/tools/gate.ts`, `src/tools/review.ts`, `src/tools/recovery.ts`, `src/tools/cycle.ts`, shared coordinator module.

**Dependencies:** Phase 1

**Done when:** review, acceptance, phase advance, reload, reset, and management operations all route through the shared per-root mutation coordinator; the coordinator is not held across long-running gate command execution; concurrent same-root lifecycle calls produce serialized, non-overwriting results under test.

**Status:** Pending

*(No tasks yet -- elaborated during execution once the Phase 1 workspace boundary is in place.)*

### Epic 2.2: Fence completion against lease takeover

**Goal:** A worker whose lease expired and was taken over cannot publish results over the new owner's attempt.

**Scope:** `src/tools/gate.ts`, `src/state/`, evidence promotion in `src/evidence/manager.ts`.

**Dependencies:** Epic 2.1

**Done when:** terminal Gate 0 evidence and task transitions revalidate the persisted lease owner and `attempt_id` immediately before writing; a stale attempt is rejected without mutating canonical state or evidence; the rejection is reported as a recoverable outcome; long-running legitimate checks have a lease renewal path.

**Status:** Pending

*(No tasks yet.)*

---

## Phase 3: Honest Reporting and Delivery Provenance

### Epic 3.1: Remove false-success paths in gates and sync

**Goal:** A gate or sync surface never reports success for work it did not actually verify or deliver.

**Scope:** `src/gates/gate1.ts`, `src/config/schema.ts`, `src/gates/gate0.ts` test-file evaluation, `src/sync/manager.ts`, `src/server.ts`, `src/context.ts`.

**Dependencies:** Phase 2

**Done when:** Gate 1 fails closed or reports an explicit non-certifying status when dependencies changed with no audit command; Gate 0 test-file enforcement fails closed when Git status is unavailable; each project root owns exactly one `SyncManager` instance; sync events carry stable identifiers so retry and replay are idempotent.

**Status:** Pending

*(No tasks yet.)*

### Epic 3.2: Pin release provenance to the validated commit

**Goal:** A release is built from the exact commit that passed CI.

**Scope:** `.github/workflows/release.yml`, `.github/workflows/ci.yml`.

**Dependencies:** none (independent of Phases 1-2, sequenced here by priority)

**Done when:** the release job checks out the triggering workflow run's head SHA rather than mutable `main`; concurrent release runs cannot interleave; third-party actions are pinned to reviewed commit SHAs.

**Status:** Pending

*(No tasks yet.)*

---

## Phase 4: Modularization and Documentation Truth

### Epic 4.1: Extract lifecycle services from tool adapters

**Goal:** MCP tool modules are thin adapters; lifecycle, recovery, and review policy live in testable services.

**Scope:** `src/tools/gate.ts`, `src/tools/review.ts`, `src/tools/recovery.ts`, new service modules, shared registration and response helpers.

**Dependencies:** Phase 2

**Done when:** task lifecycle, recovery, and review/acceptance policy are addressable without touching MCP registration code; `project_root` resolution, response construction, and registration style are centralized rather than duplicated per tool module; behavior is unchanged under the existing suite.

**Status:** Pending

*(No tasks yet.)*

### Epic 4.2: Reconcile documentation and config with runtime

**Goal:** Published docs and config examples describe the tools and cascade that actually exist.

**Scope:** `docs/architecture.md`, `README.md`, `src/config/loader.ts`, `src/config/schema.ts`, contract tests.

**Dependencies:** Epic 4.1

**Done when:** documented MCP tool names match registered tool names, verified by an executable inventory assertion; the language-pack configuration cascade is either implemented in the loader or the claim is removed from docs; every documented config example is asserted to load into a valid `RigorConfig`.

**Status:** Pending

*(No tasks yet.)*
