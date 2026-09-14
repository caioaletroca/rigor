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

#### Task 2.1.1: Extract the shared per-project mutation coordinator

- [ ] Done

**Implementation:** Move the existing root-keyed queue from `src/tools/gate.ts` into `src/lifecycle/mutation-coordinator.ts`, export it through `src/lifecycle/index.ts`, and update all existing consumers. Canonicalize root keys, preserve FIFO same-root ordering, allow different roots to overlap, release after errors, and clean idle entries. This remains in-process coordination; do not add filesystem locks.

**Files:** Create `src/lifecycle/mutation-coordinator.ts`, `src/lifecycle/index.ts`, `src/lifecycle/__tests__/mutation-coordinator.test.ts`; modify `src/tools/gate.ts`, `src/tools/recovery.ts`.

**Verification:** `npx vitest run src/lifecycle/` and `npm run build`.

#### Task 2.1.2: Route lifecycle mutations through the shared coordinator

- [ ] Done

**Implementation:** Route `cycle_init`, `cycle_reload`, review/acceptance submissions, phase advance, confirmed reset and management operations, and diagnostic reconciliation through the coordinator using the effective project root. Keep status, acceptance start, previews, and non-mutating diagnosis outside it. Ensure exported handlers are safe, not only MCP registration wrappers. Update the zero-task review message to recommend `cycle_reload`, not re-init.

**Files:** Modify `src/tools/cycle.ts`, `src/tools/review.ts`, `src/tools/recovery.ts` and their tests, including `src/tools/__tests__/multi-project.integration.test.ts`.

**Verification:** Run the affected tool test files, then `npm run build`.

#### Task 2.1.3: Split long-running gate execution from coordinated commits

- [ ] Done

**Implementation:** Refactor task start/completion and custom-gate-backed review/acceptance into prepare-under-coordinator, execute-outside-coordinator, and commit-under-coordinator phases. Preserve active-completion duplicate suppression and reload fresh state before commit. No external command or custom gate may run while the mutation coordinator is held.

**Files:** Modify `src/tools/gate.ts`, `src/tools/review.ts`, `src/tools/__tests__/gate.test.ts`, `src/tools/__tests__/review.test.ts`.

**Verification:** `npx vitest run src/tools/__tests__/gate.test.ts src/tools/__tests__/review.test.ts`, `npm test`, and `npm run build`.

### Epic 2.2: Fence completion against lease takeover

**Goal:** A worker whose lease expired and was taken over cannot publish results over the new owner's attempt.

**Scope:** `src/tools/gate.ts`, `src/state/`, evidence promotion in `src/evidence/manager.ts`.

**Dependencies:** Epic 2.1

**Done when:** terminal Gate 0 evidence and task transitions revalidate the persisted lease owner and `attempt_id` immediately before writing; a stale attempt is rejected without mutating canonical state or evidence; the rejection is reported as a recoverable outcome; long-running legitimate checks have a lease renewal path.

**Status:** Pending

#### Task 2.2.1: Add an atomic persisted lease assertion primitive

- [ ] Done

**Implementation:** Add a reusable StateManager lease-fence assertion for coordinated commit sections. Reload persisted state and verify task status, owner, attempt, expiry, and timestamp validity. Return typed recoverable outcomes for owner change, attempt takeover, expiry, status change, and malformed leases. Registered completion calls remain strict; retain isolated compatibility for legacy calls.

**Files:** Modify `src/state/schema.ts`, `src/state/manager.ts`, `src/state/index.ts`, `src/state/__tests__/manager.test.ts`.

**Verification:** `npx vitest run src/state/` and `npm run build`.

#### Task 2.2.2: Fence Gate 0 progress and terminal publication

- [ ] Done

**Implementation:** Separate attempt-history persistence from canonical evidence promotion. Before every canonical progress/terminal evidence write, task Gate 0 update, post-task result, terminal transition, and failure-path mutation, revalidate the persisted lease under the coordinator. Timestamp recency must never authorize promotion. A stale worker may retain immutable attempt history but must return a recoverable stale-attempt result without changing canonical state or evidence.

**Files:** Modify `src/tools/gate.ts`, `src/evidence/manager.ts`, `src/evidence/index.ts`, `src/tools/__tests__/gate.test.ts`, `src/evidence/__tests__/manager.test.ts`.

**Verification:** Run evidence and gate tests with deterministic delayed-attempt takeover scenarios, then `npm test` and `npm run build`.

#### Task 2.2.3: Add lease renewal for legitimate long-running attempts

- [ ] Done

**Implementation:** Add a project-root-aware `task_renew` lifecycle tool that extends a live lease only when persisted task status, owner, and attempt match. Generate expiry server-side, serialize renewal through the coordinator, and make renewal/takeover races deterministic: whichever commits first determines whether takeover or renewal succeeds. A replaced attempt can never revive itself.

**Files:** Modify `src/state/schema.ts`, `src/state/manager.ts`, `src/tools/gate.ts`, `src/tools/index.ts`, `src/tools/__tests__/gate.test.ts`, `src/tools/__tests__/transport.integration.test.ts`; config files only if renewal duration becomes configurable.

**Verification:** Run gate and transport integration tests, then `npm test` and `npm run build`.

---

## Phase 3: Honest Reporting and Delivery Provenance

### Epic 3.1: Remove false-success paths in gates and sync

**Goal:** A gate or sync surface never reports success for work it did not actually verify or deliver.

**Scope:** `src/gates/gate1.ts`, `src/config/schema.ts`, `src/gates/gate0.ts` test-file evaluation, `src/sync/manager.ts`, `src/server.ts`, `src/context.ts`.

**Dependencies:** Phase 2

**Done when:** Gate 1 fails closed or reports an explicit non-certifying status when dependencies changed with no audit command; Gate 0 test-file enforcement fails closed when Git status is unavailable; each project root owns exactly one `SyncManager` instance; sync events carry stable identifiers so retry and replay are idempotent.

**Status:** Pending

#### Task 3.1.1: Fail closed when dependency audit cannot run

- [ ] Done

**Implementation:** When enabled Gate 1 detects dependency changes and has no audit command, emit an actionable failing audit check, run no command, and preserve the old baseline. When Gate 0 test-file enforcement cannot run `git status --porcelain`, emit a failing test-files check with execution metadata. Keep disabled policy behavior unchanged.

**Files:** Modify `src/gates/gate1.ts`, `src/gates/gate0.ts`, and their tests.

**Verification:** `npx vitest run src/gates/` and `npm run build`.

#### Task 3.1.2: Make the project context own its single SyncManager

- [ ] Done

**Implementation:** Make `ProjectContextRegistry` the sole factory/cache for root-local managers. Derive default server managers, including sync, from its default context; do not independently construct a SyncManager in `createServer`. Assert repeated canonical root lookup reuses the same manager and different roots do not.

**Files:** Modify `src/server.ts`, `src/context.ts`, `src/context.test.ts`, `src/tools/__tests__/multi-project.integration.test.ts`.

**Verification:** `npx vitest run src/context.test.ts src/tools/__tests__/multi-project.integration.test.ts` and `npm run build`.

#### Task 3.1.3: Add stable sync IDs and durable delivery outcomes

- [ ] Done

**Implementation:** Add required `event_id` to SyncEvent, generate it once at lifecycle emission, persist it in the journal, and retain it through retry/replay. Persist provider delivery outcomes keyed by `(provider, event_id)` so retry selects only failed deliveries after restart; at-least-once delivery remains provider-deduplicable by the stable ID.

**Files:** Modify `src/sync/schema.ts`, `src/sync/manager.ts`, `src/state/manager.ts`, sync tests and provider factories that construct SyncEvent values.

**Verification:** `npx vitest run src/sync/ src/tools/__tests__/sync.test.ts`, `npm test`, and `npm run build`.

### Epic 3.2: Pin release provenance to the validated commit

**Goal:** A release is built from the exact commit that passed CI.

**Scope:** `.github/workflows/release.yml`, `.github/workflows/ci.yml`.

**Dependencies:** none (independent of Phases 1-2, sequenced here by priority)

**Done when:** the release job checks out the triggering workflow run's head SHA rather than mutable `main`; concurrent release runs cannot interleave; third-party actions are pinned to reviewed commit SHAs.

**Status:** Pending

#### Task 3.2.1: Pin release authorization and checkout to CI provenance

- [ ] Done

**Implementation:** Require successful same-repository `push` CI on `main`, then check out `${{ github.event.workflow_run.head_sha }}` with full history. A later push must not change release source; PR-originated CI must not enter the privileged release job.

**Files:** Modify `.github/workflows/release.yml`.

**Verification:** Static workflow assertions and `actionlint .github/workflows/*.yml` when available.

#### Task 3.2.2: Serialize release publication without cancellation

- [ ] Done

**Implementation:** Add top-level release concurrency group `release-main` with `cancel-in-progress: false`. Pinned, older queued releases may fail visibly if superseded; they must never fall back to mutable `main`.

**Files:** Modify `.github/workflows/release.yml`.

**Verification:** Static concurrency assertions and `actionlint .github/workflows/release.yml` when available.

#### Task 3.2.3: Pin workflow actions to reviewed immutable SHAs

- [ ] Done

**Implementation:** Replace every current action tag in CI, release, and PR validation workflows with reviewed 40-character commit SHAs and version comments. Pin `actions/checkout` and `actions/setup-node` v4 lines plus `amannn/action-semantic-pull-request` v5.

**Files:** Modify `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/pr-validation.yml`.

**Verification:** Search all workflow `uses:` references for full immutable SHAs, then run `actionlint` when available.

---

## Phase 4: Modularization and Documentation Truth

### Epic 4.1: Extract lifecycle services from tool adapters

**Goal:** MCP tool modules are thin adapters; lifecycle, recovery, and review policy live in testable services.

**Scope:** `src/tools/gate.ts`, `src/tools/review.ts`, `src/tools/recovery.ts`, new service modules, shared registration and response helpers.

**Dependencies:** Phase 2

**Done when:** task lifecycle, recovery, and review/acceptance policy are addressable without touching MCP registration code; `project_root` resolution, response construction, and registration style are centralized rather than duplicated per tool module; behavior is unchanged under the existing suite.

**Status:** Pending

#### Task 4.1.1: Centralize lifecycle adapter plumbing

- [ ] Done

**Implementation:** Create `src/tools/lifecycle-adapter.ts` with the shared optional `project_root` Zod parameter, normal lifecycle request-context resolver, and `responseResult`-backed text response helper. Replace local variants in gate, review, and recovery. Do not route cycle initialization/reload through it because their plan-derived root behavior is distinct.

**Files:** Create adapter and tests; modify `src/tools/gate.ts`, `src/tools/review.ts`, `src/tools/recovery.ts`, response and multi-project tests.

**Verification:** Run adapter, response, and multi-project tool tests, then build.

#### Task 4.1.2: Extract task lifecycle policy from the gate adapter

- [ ] Done

**Implementation:** Move task start/complete policy, active Gate 0 tracking, and coordinator exports to `src/services/task-lifecycle.ts` with explicit dependencies. Make `gate.ts` MCP registration/context delegation only; recovery imports service state rather than a tool module. Preserve tool schemas, text, evidence, lease, and locking behavior.

**Files:** Create `src/services/task-lifecycle.ts`; modify gate/recovery tools, service exports, and existing gate/transport tests.

**Verification:** Run gate and transport tests, then build.

#### Task 4.1.3: Extract review/acceptance/finalization policy

- [ ] Done

**Implementation:** Move review start/submit, acceptance start/submit, and phase advance policy to `src/services/review-lifecycle.ts`; leave `review.ts` as MCP registration and request-scoped dependency binding. Preserve archival behavior at the resolved root.

**Files:** Create review service; modify review tool, service exports, review and multi-project tests.

**Verification:** Run review and multi-project tests, then build.

#### Task 4.1.4: Extract recovery and management policy

- [ ] Done

**Implementation:** Move reset, retry, task/epic/phase management, and diagnosis/reconciliation policy to `src/services/recovery-lifecycle.ts`; keep recovery tool registration-only. Preserve previews, destructive safeguards, evidence cleanup, diagnostics, and current response text.

**Files:** Create recovery service; modify recovery tool, service exports, recovery/gate/multi-project/transport tests.

**Verification:** Run affected tests, `npm test`, and build.

### Epic 4.2: Reconcile documentation and config with runtime

**Goal:** Published docs and config examples describe the tools and cascade that actually exist.

**Scope:** `docs/architecture.md`, `README.md`, `src/config/loader.ts`, `src/config/schema.ts`, contract tests.

**Dependencies:** Epic 4.1

**Done when:** documented MCP tool names match registered tool names, verified by an executable inventory assertion; the language-pack configuration cascade is either implemented in the loader or the claim is removed from docs; every documented config example is asserted to load into a valid `RigorConfig`.

**Status:** Pending

#### Task 4.2.1: Add executable MCP inventory and correct tool docs

- [ ] Done

**Implementation:** Test the actual server tools/list inventory against the README MCP tools table. Correct obsolete architecture `gate.*` names and README lifecycle examples so required owner/attempt parameters are represented.

**Files:** Modify `README.md`, `docs/architecture.md`; add focused tool-inventory test.

**Verification:** Run inventory test, full tests, and build.

#### Task 4.2.2: Correct language-pack cascade documentation

- [ ] Done

**Decision:** Do not implement language-pack loading in this plan. Replace public claims with the implemented cascade: defaults → global config → selected domain defaults → project config → environment overrides. Present language packs as discovery/workflow assets, not runtime loader layers; remove nonfunctional `lang` configuration examples.

**Files:** Modify `README.md`, `docs/architecture.md`, `docs/gates.md`; loader comments only if needed for clarity.

**Verification:** `npm test` and build.

#### Task 4.2.3: Contract-test maintained config examples

- [ ] Done

**Implementation:** Turn `skills/config.example.yaml` and maintained README configuration blocks into isolated loader fixtures with semantic assertions. Reconcile documented Gate 8 default reviewers with actual defaults and remove nonfunctional language settings from examples.

**Files:** Modify config loader tests, config example, README, and schema only for a demonstrated default mismatch.

**Verification:** Run loader tests, full tests, and build.
