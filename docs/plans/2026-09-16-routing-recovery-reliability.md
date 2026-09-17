# Rigor Routing and Recovery Reliability Plan

> **For implementers:** This is a rolling-wave plan. Phase 1 tasks are
> dispatch-ready. Later phases are epic-level only -- elaborate them against
> the real codebase when execution reaches them.
> This document is the living source of truth -- task elaboration for later
> phases is written back into it during execution.

**Goal:** Make Rigor’s per-worktree lifecycle routing, stale-client diagnosis, lease recovery, and Gate 0 command readiness predictable without requiring a server restart for normal multi-project work.

**Architecture:** Treat the server-configured project root as a documented fallback only; all lifecycle operations are per-request-root capable and advertise that contract through a machine-readable server information tool. Before a task receives a lease, Rigor validates that its effective Gate 0 commands are concrete rather than unresolved variable placeholders. Lease recovery uses one consistent takeover contract from response text through state transition. This plan deliberately does not move OpenCode sessions between worktrees or add cross-process locking.

**Tech Stack:** TypeScript, MCP SDK, Commander, Vitest, JSON state/evidence, Git worktrees.

**Out of scope:** Automatic OpenCode session handoff into a newly-created worktree; host/plugin implementation; cross-process file locking; language-pack configuration loading. Language placeholders are rejected at task start until a future language-config feature supplies them.

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | Agents can discover live server/root capabilities, recover an expired task lease, and receive actionable Gate 0 readiness failures | 1.1, 1.2 | Detailed |
| 2 | Every published lifecycle tool contract is inventory-tested against the live MCP schema and cycle guidance matches runtime | 2.1, 2.2 | Epic-level |
| 3 | Global fallback-root operation and project-local configuration ergonomics are documented and operationally validated | 3.1 | Complete |

---

## Phase 1: Deterministic Routing, Recovery, and Readiness

### Epic 1.1: Expose live lifecycle capabilities and repair lease recovery

**Goal:** An agent can identify the connected server’s fallback root and root-aware tool contract, then follow a non-destructive expired-lease recovery path without guessing attempt identities or restarting the server.

**Scope:** `src/server.ts`, new server-info tool module, `src/tools/cycle.ts`, `src/services/task-lifecycle.ts`, lifecycle and transport tests, `skills/cycle/SKILL.md`.

**Dependencies:** none

**Done when:** a root-aware `rigor_status` tool reports server version, schema version, fallback root, and lifecycle tools that accept `project_root`; an expired `doing` task can be explicitly taken over through `task_start`; recovery messaging names the supported action; tests exercise the full expired-lease path.

**Status:** Pending

#### Task 1.1.1: Add a live Rigor server capability tool

- [ ] Done

**Context:** The MCP tool schema is cached by clients at connection time. The runtime already registers 23 tools across `src/tools/` while a stale OpenCode session can expose an older subset. `createServer` at `src/server.ts:45-61` owns the server version and configured fallback root, but provides no agent-readable capability handshake.

**Implementation vision:** Add a `rigor_status` MCP tool registered by the server itself or a focused `src/tools/server-info.ts` module. It is read-only and requires no project root. Return structured and text-compatible content containing: server name/version, an explicit schema version constant, canonical fallback root, and a sorted list of root-aware lifecycle tool names. Build the list from one canonical exported manifest shared with the inventory contract rather than duplicating string lists. Include a clear `reconnect_required` instruction only when the client reports a schema version lower than a future optional input; do not claim that server code can mutate a client’s cached tools.

**Files:**
- Create: `src/tools/server-info.ts`
- Create: `src/tools/__tests__/server-info.test.ts`
- Modify: `src/server.ts`
- Modify: `src/tools/index.ts`
- Modify: `src/tools/__tests__/transport.integration.test.ts`

**Verification:** `npx vitest run src/tools/__tests__/server-info.test.ts src/tools/__tests__/transport.integration.test.ts` and `npm run build`.

**Done when:** a live MCP client can call `rigor_status` and determine the configured fallback root plus whether `cycle_status`, `cycle_diagnose`, `phase_advance`, and task/review/recovery/sync tools support `project_root`.

#### Task 1.1.2: Make expired-task takeover the actual supported recovery path

- [ ] Done

**Context:** `task_renew` at `src/services/task-lifecycle.ts:292-304` tells a stale caller to start with explicit takeover. `handleTaskStart` already calculates `expiredTakeover` at `src/services/task-lifecycle.ts:137` and permits expired `doing` tasks when `takeover: true`, but recovery messages and all race cases must remain consistent after the service extraction.

**Implementation vision:** Define one explicit recovery contract: a task in `doing` with an expired, well-formed lease may be reclaimed only through `task_start({ task_id, owner_id, takeover: true, project_root })`; that call creates a fresh attempt ID and retains takeover history. A non-expired lease remains protected. Make every stale-renewal, expired-completion, and management response name this exact call shape. Do not force a status transition, reset evidence, or accept a guessed attempt ID. Ensure the commit-side lease check rejects two competing takeovers deterministically.

**Files:**
- Modify: `src/services/task-lifecycle.ts`
- Modify: `src/services/recovery-lifecycle.ts`
- Modify: `src/tools/__tests__/gate.test.ts`
- Modify: `src/services/recovery-lifecycle.test.ts`
- Modify: `src/tools/__tests__/transport.integration.test.ts`

**Verification:** `npx vitest run src/tools/__tests__/gate.test.ts src/services/recovery-lifecycle.test.ts src/tools/__tests__/transport.integration.test.ts` and `npm run build`.

**Done when:** an end-to-end test proves expired lease → stale renewal response → explicit takeover → new attempt ID → successful renewal, while active leases and competing takeovers remain rejected.

#### Task 1.1.3: Correct cycle guidance for root-aware clients

- [ ] Done

**Context:** `skills/cycle/SKILL.md:47,105` still claims `cycle_status` and `cycle_diagnose` are server-root-bound even though merged runtime schemas accept `project_root`. This caused agents to request unnecessary server restarts.

**Implementation vision:** State that every lifecycle call must use the active worktree’s absolute `project_root`, including `cycle_status`, `cycle_diagnose`, and `phase_advance`. Add a stale-schema recovery table: call `rigor_status`; if the client’s exposed tool schema lacks an advertised parameter/tool, reconnect OpenCode/MCP before mutation. Do not tell agents to restart Rigor merely because its fallback root differs when the current client schema supports explicit roots.

**Files:**
- Modify: `skills/cycle/SKILL.md`
- Modify: `skills/worktree/SKILL.md` only if its handoff wording contradicts this contract

**Verification:** inspect for root-aware examples and stale-schema guidance; run `npm run build`.

**Done when:** the cycle skill gives an agent the correct root-aware call pattern and reserves reconnect instructions for demonstrably stale client schemas.

### Epic 1.2: Validate Gate 0 readiness before work is leased

**Goal:** A project with unresolved Gate 0 commands fails before task implementation begins, naming the unresolved variable and configuration source rather than shell-executing `${...}`.

**Scope:** `src/gates/gate0.ts`, `src/services/task-lifecycle.ts`, config/source metadata helpers, Gate 0 and task lifecycle tests.

**Dependencies:** none

**Done when:** task start rejects unresolved or empty effective Gate 0 commands when `allow_empty` is false; no shell command runs; diagnostics identify placeholders such as `lang.test_command` and the configuration file/domain default that supplied them; projects with explicit runnable checks still start unchanged.

**Status:** Pending

#### Task 1.2.1: Add effective Gate 0 command readiness validation

- [ ] Done

**Context:** `checkGate0Exit` currently iterates checks at `src/gates/gate0.ts:77-92`; an unresolved `${lang.test_command}` is nonempty and is shell-executed literally. Backoffice evidence demonstrated six placeholder strings reaching Windows `cmd`. `loadConfig` at `src/config/loader.ts:271-308` returns an effective config but does not retain command provenance.

**Implementation vision:** Add a pure readiness evaluator in the gate/config boundary. A command is unresolved when it contains `${...}`; report each variable name without executing it. An empty command is non-runnable. If no runnable checks remain and `allow_empty` is false, return one actionable failed readiness result. Invoke this evaluator from `task_start` after config reload but before pre-task/Gate 1 work, state transition, lease issue, or evidence write. For a check list containing both concrete and unresolved commands, fail readiness rather than silently run only the concrete subset: configured checks are a declared quality contract. Preserve `allow_empty: true` behavior only for intentionally empty check sets, not unresolved variables.

**Files:**
- Modify: `src/gates/gate0.ts`
- Modify: `src/services/task-lifecycle.ts`
- Modify: `src/gates/__tests__/gate0.test.ts`
- Modify: `src/tools/__tests__/gate.test.ts`

**Verification:** `npx vitest run src/gates/__tests__/gate0.test.ts src/tools/__tests__/gate.test.ts` and `npm run build`.

**Done when:** unresolved placeholders are reported as `Unresolved configuration variable: <name>` before a task lease is written, `runCommand` is not invoked for literal placeholders, and runnable explicit project checks remain unaffected.

#### Task 1.2.2: Attribute readiness failures to configuration sources

- [ ] Done

**Context:** The current cascade (`DEFAULTS → global config → selected domain defaults → project config → environment overrides`) is documented but `RigorConfig` does not retain the source of each effective check. An actionable readiness failure must distinguish a project config error from a domain default that needs overriding.

**Implementation vision:** Add lightweight, read-only config provenance for Gate 0 checks: return the effective source category and path for the selected domain defaults and project config that contributed commands. Do not build a general field-by-field provenance system. When readiness detects `${lang.*}`, include the source category/path in the response and suggest the minimal correction: set a concrete `gates.gate_0.checks` list in the project config, or remove/resolve the domain check. Keep secrets out of diagnostics.

**Files:**
- Modify: `src/config/loader.ts`
- Modify: `src/config/index.ts`
- Modify: `src/services/task-lifecycle.ts`
- Modify: `src/config/__tests__/loader.test.ts`
- Modify: `src/tools/__tests__/gate.test.ts`

**Verification:** `npx vitest run src/config/__tests__/loader.test.ts src/tools/__tests__/gate.test.ts` and `npm run build`.

**Done when:** task-start readiness text identifies both the unresolved variable and whether its command came from project configuration or selected domain defaults, with a concrete override instruction.

---

## Phase 2: Contract Completeness and Client Compatibility

### Epic 2.1: Test every root-aware lifecycle schema through live MCP inventory

**Goal:** Runtime schema drift is caught before release.

**Scope:** server-info manifest, MCP transport/inventory tests, every lifecycle registration module.

**Dependencies:** Phase 1

**Done when:** a real `tools/list` client test asserts that every lifecycle mutation and inspection tool advertises an absolute optional `project_root` where its behavior supports routing; server-info and tools/list stay in sync; adding a new lifecycle tool without the root contract fails tests.

**Status:** Pending

#### Task 2.1.1: Strengthen the live root-aware MCP inventory contract

- [ ] Done

**Implementation:** Extend the live transport-harness inventory test. Use the list returned by `rigor_status` as the client-observed source, compare it to the canonical root-aware manifest, and assert every advertised `tools/list` schema has an optional string `project_root` with absolute-root routing description. Preserve the exact full tool/README inventory assertion. Do not modify registrations unless the test exposes a real omission.

**Files:** Modify `src/tools/__tests__/transport.integration.test.ts`; modify `src/tools/server-info.ts` only if live metadata is inaccurate.

**Verification:** `npx vitest run src/tools/__tests__/transport.integration.test.ts src/tools/__tests__/server-info.test.ts` and `npm run build`.

### Epic 2.2: Add stale-client capability guidance to installed commands and docs

**Goal:** Users and agents identify a stale OpenCode MCP schema before attempting lifecycle recovery.

**Scope:** OpenCode commands, cycle/worktree skills, README troubleshooting.

**Dependencies:** Epic 2.1

**Done when:** docs and installed commands explain `rigor_status`, show the reconnect boundary, and distinguish fallback-root configuration from per-request routing.

**Status:** Pending

#### Task 2.2.1: Verify installed command artifacts preserve capability guidance

- [ ] Done

**Implementation:** Test command installation across OpenCode, Claude, and Hermes. OpenCode/Claude must install reference wrappers to the canonical cycle skill; Hermes must copy the current skill content containing `rigor_status`, stale-schema reconnect, and no-restart-for-fallback-mismatch guidance. Preserve non-overwrite behavior and Hermes update instructions.

**Files:** Modify `src/tools/__tests__/scaffold.test.ts`; modify `src/tools/scaffold.ts` only if tests reveal an installer defect.

**Verification:** `npx vitest run src/tools/__tests__/scaffold.test.ts` and `npm run build`.

#### Task 2.2.2: Add concise operator-facing stale-schema troubleshooting

- [ ] Done

**Implementation:** Add README troubleshooting that distinguishes fallback root from per-request absolute worktree root, directs users to `rigor_status`, requires MCP reconnect only for a stale client inventory, and documents Hermes copied-skill refresh versus OpenCode/Claude references. Do not duplicate the full cycle skill or prescribe restart for a fallback mismatch.

**Files:** Modify `README.md`; modify `skills/cycle/SKILL.md` only if inconsistent.

**Verification:** `npx vitest run src/tools/__tests__/transport.integration.test.ts src/tools/__tests__/scaffold.test.ts` and `npm run build`.

---

## Phase 3: Fallback-Root Configuration and Operational Readiness

### Epic 3.1: Make fallback-root behavior explicit and validate project readiness

**Goal:** Global MCP configuration is clearly a fallback, while worktree-specific projects can self-diagnose effective root and runnable gates before a cycle begins.

**Scope:** server CLI/config docs, project readiness tool or pre-init validation, README, skills.

**Dependencies:** Phase 2

**Done when:** fallback-root semantics are documented; `cycle_init` or a dedicated readiness tool reports effective root, worktree policy, and certifiable Gate 0 commands; no normal multi-project workflow requires rewriting global OpenCode config.

**Status:** Complete

#### Task 3.1.1: Add a read-only project readiness preflight

- [x] Done

**Implementation:** Add root-aware `project_readiness` returning canonical root/source/fallback warning, workspace-policy inspection, and Gate 0 readiness/provenance without creating state, leases, evidence, or running commands. Explicit roots, plan-derived roots, and fallback roots must remain distinguishable. A fallback result is diagnostic only and tells lifecycle callers to pass the active worktree’s absolute root.

**Files:** Create `src/tools/readiness.ts`, `src/tools/__tests__/readiness.test.ts`; modify `src/server.ts`, `src/tools/index.ts`, `src/tools/server-info.ts`, and transport tests.

**Verification:** Run readiness/transport/server-info tests and `npm run build`.

#### Task 3.1.2: Reuse preflight before cycle initialization and task leasing

- [x] Done

**Implementation:** Extract shared project-readiness evaluation consumed by `project_readiness`, `cycle_init`, and `task_start`. `cycle_init` must fail before state initialization and `task_start` before Git/custom/Gate 1/evidence/lease side effects. Explicit ready roots must work even with an unready fallback. `allow_shared_workspace` retains its narrow policy exception and never bypasses invalid root or Gate 0 readiness.

**Files:** Create `src/services/project-readiness.ts`; modify readiness/cycle/task lifecycle services and their tests.

**Verification:** Run cycle/gate/multi-project/readiness tests, full suite, and build.

#### Task 3.1.3: Document fallback-root and preflight operations

- [x] Done

**Implementation:** Document `rigor_status` → `project_readiness` → worktree-local correction → `cycle_init` sequence. State fallback root is backward-compatible only, per-request absolute root is normal, readiness is read-only, and reconnect is only for stale client tool inventory.

**Files:** Modify `README.md`, `skills/cycle/SKILL.md`, and this plan; update installer tests only if canonical skill guidance assertions need extension.

**Verification:** Run transport/scaffold tests and build.

---

## Self-Review

- P0 server handshake is Epic 1.1 Task 1.1.1; root-aware client guidance is Task 1.1.3.
- P1 expired lease recovery is Task 1.1.2; unresolved command readiness and source attribution are Tasks 1.2.1–1.2.2.
- P2 live root-aware inventory and fallback-root operational semantics are Phases 2–3, intentionally deferred until Phase 1 establishes contracts.
- Phase 1 verifies concrete MCP, lease, and Gate 0 behavior without changing OpenCode session location or adding cross-process locks.
