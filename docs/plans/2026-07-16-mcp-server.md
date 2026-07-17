# Rigor MCP Gate Server Implementation Plan

> **For implementers:** This is a rolling-wave plan. Phase 1 tasks are
> dispatch-ready. Later phases are epic-level only -- elaborate them against
> the real codebase when execution reaches them.
> This document is the living source of truth -- task elaboration for later
> phases is written back into it during execution.

**Goal:** Build a TypeScript MCP server that enforces rigor's deterministic quality gates -- state machine transitions, shell-based exit criteria checks, evidence persistence -- so AI agents cannot bypass or self-certify gate passage.

**Architecture:** A stdio-based MCP server using `@modelcontextprotocol/sdk`. The server exposes tools for cycle management (init, status), task lifecycle (start, complete), and review/acceptance flows. State persists to `.rigor/state.json`; evidence to `.rigor/evidence/`. Config loads from `.rigor/config.yaml` with typed defaults. The server runs shell commands (tests, lint, coverage) itself and returns structured pass/fail results -- the agent never parses tool output or touches state files.

**Tech Stack:** TypeScript 5.x, Node.js 20+, `@modelcontextprotocol/sdk` (MCP protocol), `yaml` (config parsing), `node:child_process` (shell execution), `node:fs` (state/evidence I/O)

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | MCP server starts, reads config, parses a plan, initializes a cycle, and reports status via tools | 1.1, 1.2, 1.3, 1.4 | Detailed |
| 2 | Gate 0 enforcement works: `task_start` checks entry criteria, `task_complete` runs tests/lint/coverage and persists evidence | 2.1, 2.2 | Epic-level |
| 3 | Full cycle: Gate 8 review submission + Gate 9 acceptance + phase boundary advancement | 3.1, 3.2, 3.3 | Epic-level |
| 4 | Production-ready: custom gates, Gate 1 infrastructure, error recovery, `rigor:cycle` skill | 4.1, 4.2, 4.3 | Epic-level |

---

## Phase 1: Foundation

### Epic 1.1: Project scaffolding and config loader

**Goal:** TypeScript project compiles, lints, tests, and reads `.rigor/config.yaml` into a typed object with defaults
**Scope:** project root (`package.json`, `tsconfig.json`), `src/config/`
**Dependencies:** none
**Done when:** `npm run build` produces `dist/`, `npm test` passes, config loader returns typed defaults when no config file exists and merges overrides when it does
**Status:** Pending

#### Task 1.1.1: Initialize TypeScript project

- [ ] Done

**Context:** The rigor repo at `C:\Users\caio_\Projects\rigor` currently has no `package.json` or `src/` directory. `install.mjs` is a standalone ESM script with no build step. The MCP server will live alongside the existing skills and docs.

**Implementation vision:** Initialize a Node.js project with `package.json` (name: `@rigor/gate-server`, type: `module`, bin pointing to `dist/server.js`). Add dev dependencies: `typescript`, `@types/node`, `vitest` (test runner -- lightweight, ESM-native, no config needed for simple cases). Add runtime dependencies: `@modelcontextprotocol/sdk`, `yaml`. Create `tsconfig.json` targeting ES2022, NodeNext module resolution, strict mode, outDir `./dist`, rootDir `./src`. Add scripts: `build` (`tsc`), `dev` (`tsc --watch`), `test` (`vitest run`), `start` (`node dist/server.js`). Create `src/` directory.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/server.ts` (empty entry point with `#!/usr/bin/env node` shebang)

**Verification:** `npm install && npm run build` succeeds with zero errors; `dist/server.js` exists.

**Done when:** Project compiles cleanly, all scripts defined, dist/ output produced.

---

#### Task 1.1.2: Implement config loader with typed defaults

- [ ] Done

**Context:** The config structure is fully defined in `skills/config.example.yaml` (117 lines). The MCP server must read `.rigor/config.yaml` from the **target project's** working directory (not rigor's own repo). Every field has a default value documented in that file.

**Implementation vision:** Create a `RigorConfig` TypeScript interface mirroring the YAML structure: `commit` (gpg_sign, trailers, types, require_scope), `ship` (branch_pattern, force_push), `gates` (gate_0 with coverage_threshold/lint_command/test_command/require_test_files, gate_8 with reviewers/required_reviewers/max_critical_findings/max_high_findings, gate_9 with require_user_approval). Create a `DEFAULTS` const object with all default values matching `skills/config.example.yaml`. The `loadConfig(projectRoot: string)` function: read `<projectRoot>/.rigor/config.yaml`, parse with the `yaml` package, deep-merge with defaults (config overrides defaults, missing keys fall back to defaults). If the file does not exist, return defaults. If the file exists but has parse errors, throw with a clear message including the file path and YAML error. Export both the function and the interface.

**Files:**
- Create: `src/config/schema.ts` (RigorConfig interface + DEFAULTS)
- Create: `src/config/loader.ts` (loadConfig function)
- Create: `src/config/index.ts` (re-exports)
- Test: `src/config/__tests__/loader.test.ts`

**Verification:** `npm test -- --reporter=verbose` -- tests pass for: no config file returns defaults, valid config merges with defaults, invalid YAML throws descriptive error, partial config fills missing fields from defaults.

**Done when:** Config loader reads YAML, merges with typed defaults, handles missing file and parse errors, all test cases pass.

---

### Epic 1.2: State manager

**Goal:** Cycle state persists to `.rigor/state.json` with atomic writes and typed transitions
**Scope:** `src/state/`
**Dependencies:** none
**Done when:** state manager creates/reads/updates state, atomic writes prevent corruption, transitions reject invalid state changes (e.g., task "done" before "doing")
**Status:** Pending

#### Task 1.2.1: Define state schema and types

- [ ] Done

**Context:** The state structure is described in `docs/architecture.md` (state persistence section). It tracks the current cycle: which plan is being executed, which phase/epic/task is active, and what gate each entity is at. Status values are: `pending`, `doing`, `done`, `failed`.

**Implementation vision:** Define a `CycleState` interface: `cycle_id` (string, derived from plan filename), `plan_path` (string, path to plan.md), `current_phase` (number), `phases` array where each phase has `id` (number), `status`, and `epics` array. Each epic has `id` (string like "1.1"), `name` (string), `status`, `tasks` array, `gate_8` (`{ passed: boolean, evidence_path?: string }`), `gate_9` (same shape). Each task has `id` (string like "1.1.1"), `name` (string), `status`, `gate_0` (`{ passed: boolean, evidence_path?: string, coverage?: number, lint_passed?: boolean, tests_passed?: boolean }`). Define a `Status` enum: `pending | doing | done | failed`. Define valid transitions: `pending -> doing`, `doing -> done`, `doing -> failed`, `failed -> doing` (retry). Any other transition is invalid.

**Files:**
- Create: `src/state/schema.ts` (CycleState, Phase, Epic, Task, Status types + valid transitions map)

**Verification:** `npm run build` -- types compile cleanly, no `any` types used.

**Done when:** All state types are defined with a transition validation function that returns true/false for a given from->to status change.

---

#### Task 1.2.2: Implement state manager with atomic writes

- [ ] Done

**Context:** The state file lives at `<projectRoot>/.rigor/state.json`. It is the single source of truth for cycle progress. The agent never reads or writes this file directly -- only the MCP server does. Concurrent writes are not expected (one agent per cycle), but crash-safety matters: a half-written state file corrupts the cycle.

**Implementation vision:** Create a `StateManager` class. Constructor takes `projectRoot` and creates `.rigor/` directory if missing. Methods: `load(): CycleState | null` (read state.json, return null if not found), `save(state: CycleState): void` (write to state.json.tmp then rename -- atomic on all OS), `init(planPath: string, phases: Phase[]): CycleState` (create initial state from parsed plan), `transition(entityId: string, toStatus: Status): CycleState` (find entity by id, validate transition, update, save, return new state). The `transition` method MUST validate using the transitions map from Task 1.2.1 -- if invalid, throw `InvalidTransitionError` with current status, requested status, and entity id. Also add `getTask(taskId: string)`, `getEpic(epicId: string)`, `getPhase(phaseId: number)` convenience methods that throw `EntityNotFoundError` if the id doesn't exist.

**Files:**
- Create: `src/state/manager.ts` (StateManager class)
- Create: `src/state/errors.ts` (InvalidTransitionError, EntityNotFoundError)
- Create: `src/state/index.ts` (re-exports)
- Test: `src/state/__tests__/manager.test.ts`

**Verification:** `npm test -- --reporter=verbose` -- tests pass for: init creates state from plan, save + load round-trips, atomic write survives simulated crash (write .tmp then verify rename), invalid transition throws, entity lookup works and fails correctly.

**Done when:** State manager handles full CRUD lifecycle, transitions are validated, writes are atomic, all tests pass.

---

### Epic 1.3: Plan parser

**Goal:** Parser reads a plan.md (rigor:plan format) and extracts the phase-epic-task hierarchy into typed structures
**Scope:** `src/plan/`
**Dependencies:** Epic 1.2 (uses state types for Phase/Epic/Task)
**Done when:** parser extracts all phases, epics, and tasks from a valid plan.md; returns an error for malformed plans; handles both detailed (Phase 1) and epic-level (later phases) sections
**Status:** Pending

#### Task 1.3.1: Implement plan parser

- [ ] Done

**Context:** The plan format is defined in `skills/plan/SKILL.md`. Key structural markers: `## Phase Overview` table, `### Epic N.M: [Name]` headers, `#### Task N.M.T: [Name]` headers. Each epic has `**Goal:**`, `**Scope:**`, `**Dependencies:**`, `**Done when:**`, `**Status:**` fields. Each task has `**Context:**`, `**Implementation vision:**`, `**Files:**`, `**Verification:**`, `**Done when:**` fields. The Phase Overview table has columns: Phase, Milestone, Epics, Status.

**Implementation vision:** Create a `parsePlan(filePath: string): ParsedPlan` function. `ParsedPlan` contains: `title` (from H1), `goal`, `architecture`, `tech_stack`, `phases` (from Phase Overview table), and nested epics/tasks. Parsing strategy: read the file as string, split into sections by heading level. For the Phase Overview table: regex match the markdown table rows, extract phase number, milestone, epic ids, and status. For epics: match `### Epic (\d+\.\d+): (.+)` headers, then extract the bold-prefixed fields below. For tasks: match `#### Task (\d+\.\d+\.\d+): (.+)` headers within epic blocks, extract fields. Tasks only exist in Phase 1 (or whatever the Phase Overview marks as "Detailed") -- later phases have epics without tasks and that is valid. The `- [ ] Done` checkbox state maps to the task status (checked = done, unchecked = pending). Return typed objects matching the state schema types. If the file is not found or has no Phase Overview table, throw `PlanParseError` with a clear message.

**Files:**
- Create: `src/plan/parser.ts` (parsePlan function)
- Create: `src/plan/types.ts` (ParsedPlan interface)
- Create: `src/plan/errors.ts` (PlanParseError)
- Create: `src/plan/index.ts` (re-exports)
- Test: `src/plan/__tests__/parser.test.ts`
- Create: `src/plan/__tests__/fixtures/sample-plan.md` (test fixture matching rigor:plan format)

**Verification:** `npm test -- --reporter=verbose` -- tests pass for: sample plan parses correctly with all phases/epics/tasks, epic-level-only phases have zero tasks (valid), missing Phase Overview throws, task checkbox state is read correctly, field extraction handles multiline values.

**Done when:** Parser extracts the full plan hierarchy, handles both detailed and epic-level sections, returns typed objects, and errors on malformed input.

---

### Epic 1.4: MCP server bootstrap with cycle tools

**Goal:** MCP server starts via stdio, exposes `cycle_init` and `cycle_status` tools that create and query development cycles
**Scope:** `src/server.ts`, `src/tools/`
**Dependencies:** Epic 1.1 (config), Epic 1.2 (state), Epic 1.3 (plan parser)
**Done when:** MCP server starts, `cycle_init` reads a plan and creates a cycle, `cycle_status` returns the current state, both tools return structured JSON responses, server handles errors gracefully
**Status:** Pending

#### Task 1.4.1: Bootstrap MCP server with stdio transport

- [ ] Done

**Context:** The MCP SDK pattern is: create `McpServer`, register tools, connect to `StdioServerTransport`. A reference implementation exists at `C:\Users\caio_\Projects\browser-tools-mcp\browser-tools-mcp\mcp-server.ts` (though we do not depend on it). The rigor server needs to know the target project's root directory to find `.rigor/config.yaml` and `.rigor/state.json`. This can be passed as a CLI argument or detected from `process.cwd()`.

**Implementation vision:** In `src/server.ts`: import `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js` and `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`. Parse CLI args: `--project-root <path>` (optional, defaults to `process.cwd()`). Create the server with name `rigor-gate-server` and version from package.json. Load config via `loadConfig(projectRoot)`. Create `StateManager` with `projectRoot`. Register tools (separate files, imported). Connect transport. Add a top-level try/catch that logs to stderr (stdout is reserved for MCP protocol). Add the shebang `#!/usr/bin/env node` for direct execution.

**Files:**
- Modify: `src/server.ts` (replace empty entry point with full bootstrap)

**Verification:** `npm run build && node dist/server.js --help` -- does not crash, prints usage or starts (stdio servers block on stdin, so starting without a client is expected behavior -- verify it doesn't throw).

**Done when:** Server bootstraps, loads config, creates state manager, and is ready to accept MCP tool calls.

---

#### Task 1.4.2: Implement cycle_init tool

- [ ] Done

**Context:** `cycle_init` is the first tool an agent calls to start a development cycle. It takes a plan path, parses the plan, and creates the initial state. The agent cannot proceed to any gate without first initializing a cycle.

**Implementation vision:** Register an MCP tool named `cycle_init` with parameter `plan_path` (string, required). The tool: (1) check if a cycle already exists (state.json present) -- if so, return an error asking the user to confirm reset or use the existing cycle, (2) call `parsePlan(planPath)` to extract the plan hierarchy, (3) call `stateManager.init(planPath, parsedPhases)` to create the initial state, (4) return a structured response with cycle_id, phase count, total epic count, Phase 1 task count, and a message confirming the cycle is ready. The response format for all tools should be consistent: `{ success: boolean, data?: any, error?: string }`.

**Files:**
- Create: `src/tools/cycle.ts` (cycle_init and cycle_status tool registrations)
- Test: `src/tools/__tests__/cycle.test.ts`

**Verification:** `npm test -- --reporter=verbose` -- tests mock the state manager and plan parser, verify cycle_init creates state from plan, rejects when cycle already exists, and returns structured response.

**Done when:** `cycle_init` parses a plan, creates initial state, returns structured confirmation, and rejects duplicate initialization.

---

#### Task 1.4.3: Implement cycle_status tool

- [ ] Done

**Context:** `cycle_status` is a read-only tool that returns the current cycle state. Agents call it to understand where the cycle is at before requesting a gate transition.

**Implementation vision:** Register an MCP tool named `cycle_status` with no required parameters. The tool: (1) load current state via `stateManager.load()`, (2) if no state exists, return `{ success: false, error: "No active cycle. Run cycle_init first." }`, (3) if state exists, return a summary: current phase, phase status, per-epic status with gate pass/fail indicators, active task (if any), overall progress percentage (tasks done / total tasks in current phase). The summary should be human-readable text that an agent can relay to the user, not just raw JSON.

**Files:**
- Modify: `src/tools/cycle.ts` (add cycle_status registration)
- Modify: `src/tools/__tests__/cycle.test.ts` (add cycle_status tests)

**Verification:** `npm test -- --reporter=verbose` -- tests verify status returns correct summary for: no active cycle, fresh cycle (all pending), mid-progress cycle, completed phase.

**Done when:** `cycle_status` returns human-readable progress for any cycle state, handles missing state gracefully.

---

## Phase 2: Gate 0 Enforcement

### Epic 2.1: Shell command executor

**Goal:** A safe, sandboxed shell executor that runs test/lint/coverage commands and captures structured results
**Scope:** `src/executor/`
**Dependencies:** Epic 1.1 (config provides commands)
**Done when:** executor runs shell commands with timeouts, captures stdout/stderr/exit code, parses coverage output for supported formats (lcov, go cover, jest), and returns typed results
**Status:** Pending

### Epic 2.2: Gate 0 tools and evidence

**Goal:** `task_start` and `task_complete` tools enforce Gate 0 entry/exit criteria with evidence persistence
**Scope:** `src/tools/`, `src/gates/`, `src/evidence/`
**Dependencies:** Epic 2.1 (executor), Epic 1.2 (state), Epic 1.1 (config thresholds)
**Done when:** `task_start` validates entry criteria (task exists, previous task done, clean tree), `task_complete` runs configured test/lint commands via executor, compares coverage to threshold, persists evidence JSON, advances state on pass, rejects on fail with clear error messages
**Status:** Pending

---

## Phase 3: Review and Acceptance Gates

### Epic 3.1: Gate 8 review tools

**Goal:** `review_start` and `review_submit` tools manage the review gate lifecycle
**Scope:** `src/tools/`, `src/gates/`
**Dependencies:** Phase 2 (Gate 0 must work first; Gate 8 entry requires all tasks passed)
**Done when:** `review_start` validates all tasks in epic passed Gate 0, `review_submit` validates required reviewers submitted and finding counts are within thresholds, evidence is persisted
**Status:** Pending

### Epic 3.2: Gate 9 acceptance tools

**Goal:** `accept_start` and `accept_submit` tools manage acceptance with optional user approval
**Scope:** `src/tools/`, `src/gates/`
**Dependencies:** Epic 3.1 (Gate 8 must pass before Gate 9)
**Done when:** `accept_start` validates Gate 8 passed, `accept_submit` validates all criteria have evidence, user approval is collected when `require_user_approval` is true in config
**Status:** Pending

### Epic 3.3: Phase boundary advancement

**Goal:** `phase_advance` tool transitions the cycle to the next phase after all epics in the current phase pass Gate 9
**Scope:** `src/tools/`, `src/state/`
**Dependencies:** Epic 3.2 (acceptance must work)
**Done when:** `phase_advance` validates all epics in current phase are done, updates phase status, sets next phase to active, returns a summary of what was completed and what's next
**Status:** Pending

---

## Phase 4: Production Readiness

### Epic 4.1: Custom gates and Gate 1

**Goal:** Support user-defined custom gates from config and the conditional infrastructure gate (Gate 1)
**Scope:** `src/gates/`, `src/config/`, `src/tools/`
**Dependencies:** Phase 2 (Gate 0 pattern to extend)
**Done when:** custom gates with arbitrary shell commands run at configured positions in the cycle, Gate 1 triggers conditionally when new dependencies are introduced
**Status:** Pending

#### Task 4.1.1: Add custom gate config schema and runner

- [ ] Done

**Context:** Gates are currently hardcoded (gate0, gate8, gate9). Users need to define custom shell-command gates that run at specific positions: `pre_task` (before task_start), `post_task` (after task_complete), `pre_review` (before review_start), `post_accept` (after accept_submit). Each custom gate specifies a name, a shell command, and the position. The executor (`src/executor/runner.ts`) already runs arbitrary commands — the custom gate runner just wraps it with evidence.

**Implementation vision:** Extend `GatesConfig` in `src/config/schema.ts` with `custom_gates: CustomGateConfig[]` where `CustomGateConfig` is `{ name: string, command: string, position: "pre_task" | "post_task" | "pre_review" | "post_accept", timeout_ms?: number }`. Default: empty array. Create `src/gates/custom.ts` with `runCustomGates(position, entityId, config, projectRoot): CustomGateResult` that filters custom gates by position, runs each command via `runCommand`, collects results, and returns `{ passed: boolean, results: CheckResult[] }`. A single failing command fails the whole custom gate set for that position. Persist evidence as `custom-${position}-${entityId}.json`.

**Files:**
- Modify: `src/config/schema.ts` (add CustomGateConfig, extend GatesConfig)
- Modify: `src/config/loader.ts` (add custom_gates default)
- Create: `src/gates/custom.ts` (runCustomGates function)
- Create: `src/gates/__tests__/custom.test.ts`

**Verification:** `npm test -- --reporter=verbose` — tests pass for: no custom gates = pass-through, single passing gate, single failing gate, multiple gates where one fails, correct position filtering, evidence saved.

**Done when:** Custom gates run at configured positions, commands execute via the existing executor, results produce evidence, failures block progression.

---

#### Task 4.1.2: Wire custom gates into tool handlers

- [ ] Done

**Context:** Task 4.1.1 creates the custom gate runner; this task integrates it into the existing tool handlers. `pre_task` gates run inside `task_start` after entry validation but before transitioning to "doing". `post_task` gates run inside `task_complete` after Gate 0 passes. `pre_review` gates run inside `review_start` after entry validation. `post_accept` gates run inside `accept_submit` after Gate 9 passes.

**Implementation vision:** Modify `src/tools/gate.ts`: in `handleTaskStart`, after entry validation, call `runCustomGates("pre_task", taskId, config, projectRoot)` — if it fails, return error without transitioning. In `handleTaskComplete`, after Gate 0 passes, call `runCustomGates("post_task", taskId, config, projectRoot)` — if it fails, transition to failed. Modify `src/tools/review.ts`: in `handleReviewStart`, after validation, call `runCustomGates("pre_review", epicId, config, projectRoot)`. In `handleAcceptSubmit`, after Gate 9, call `runCustomGates("post_accept", epicId, config, projectRoot)`. Save all custom gate evidence via evidenceManager.

**Files:**
- Modify: `src/tools/gate.ts` (add pre_task/post_task hooks)
- Modify: `src/tools/review.ts` (add pre_review/post_accept hooks)
- Modify: `src/tools/__tests__/gate.test.ts` (add custom gate integration tests)
- Modify: `src/tools/__tests__/review.test.ts` (add custom gate integration tests)

**Verification:** `npm test -- --reporter=verbose` — tests verify custom gates block progression on failure, pass through when no custom gates configured, evidence is saved for custom gate runs.

**Done when:** All four hook positions are wired, custom gate failures block the host operation, existing tests still pass.

---

#### Task 4.1.3: Implement Gate 1 infrastructure check

- [ ] Done

**Context:** Gate 1 is a conditional gate that runs when new dependencies are introduced (new entries in package.json, go.mod, etc.). It validates that infrastructure is sound: lock file in sync, no known vulnerabilities (`npm audit`, `go vet`), build still passes. It should only trigger when dependencies actually changed — not on every task. Detection: compare current dependency files against a baseline snapshot stored in `.rigor/baselines/`.

**Implementation vision:** Create `src/gates/gate1.ts` with: `detectDependencyChanges(projectRoot): boolean` — hashes current package.json/go.mod/go.sum and compares to `.rigor/baselines/deps.json` (if no baseline, first run creates it and returns false — no changes to gate). `checkGate1Exit(config, projectRoot): Gate1Result` — runs `npm audit --audit-level=moderate` or `go vet ./...` depending on detected ecosystem, validates lock file exists and is recent, returns checks array. `saveBaseline(projectRoot)` — snapshots current dep files. The gate1 config extends `GatesConfig`: `gate_1: { enabled: boolean, audit_command?: string }` with defaults `{ enabled: true }`. Wire into `task_start` — after pre_task custom gates, if dependency changes detected, run Gate 1. Save evidence as `gate_1-${taskId}.json`.

**Files:**
- Create: `src/gates/gate1.ts` (detection + check + baseline functions)
- Modify: `src/config/schema.ts` (add Gate1Config)
- Modify: `src/tools/gate.ts` (wire Gate 1 into task_start)
- Create: `src/gates/__tests__/gate1.test.ts`

**Verification:** `npm test -- --reporter=verbose` — tests verify: no baseline = creates one and passes, unchanged deps = skipped, changed deps = runs audit, audit failure blocks task_start, evidence saved.

**Done when:** Gate 1 conditionally detects dependency changes, runs infrastructure validation, and blocks task_start when validation fails.

---

### Epic 4.2: Error recovery and state repair

**Goal:** The server recovers gracefully from crashes, interrupted cycles, and corrupted state
**Scope:** `src/state/`, `src/tools/`
**Dependencies:** Phase 3 (full state machine must exist)
**Done when:** server detects corrupted state on startup and offers repair, `cycle_reset` tool allows restarting a failed gate without losing the whole cycle, interrupted tasks can be retried
**Status:** Pending

#### Task 4.2.1: State validation and corruption detection

- [ ] Done

**Context:** Currently `StateManager.load()` reads state.json and returns it with no validation beyond JSON parsing. If the file has invalid structure (missing fields, impossible status values, orphaned entities), it's silently accepted. On startup, the server should validate state integrity and report problems.

**Implementation vision:** Create `src/state/validator.ts` with `validateState(state: CycleState): ValidationResult` where `ValidationResult` is `{ valid: boolean, errors: string[], warnings: string[] }`. Checks: (1) all status values are valid enum members, (2) no entity is "doing" without a prior "pending" (structural impossibility after crash), (3) phase/epic/task ids follow expected format, (4) current_phase exists in phases array, (5) evidence paths in gate results point to files that exist on disk, (6) no two entities share the same id. Also add `detectStuckEntities(state): string[]` — returns entity ids that are in "doing" status (likely from a crash mid-operation). Integrate into `StateManager.load()`: after reading, validate. If errors found, return the state but include a `_validation` property with the errors (don't throw — let the caller decide).

**Files:**
- Create: `src/state/validator.ts` (validateState, detectStuckEntities)
- Modify: `src/state/manager.ts` (call validator on load)
- Modify: `src/state/index.ts` (export validator)
- Create: `src/state/__tests__/validator.test.ts`

**Verification:** `npm test -- --reporter=verbose` — tests for: valid state passes, invalid status value detected, stuck "doing" entity detected, missing evidence file warned, duplicate id detected.

**Done when:** State validation runs on every load, problems are reported without crashing, stuck entities are detected.

---

#### Task 4.2.2: Implement cycle_reset and task_retry tools

- [ ] Done

**Context:** Agents need recovery tools when things go wrong: a failed gate should be retryable without restarting the whole cycle, and a corrupted/stuck cycle should be resettable. Currently `failed -> doing` transitions are valid, but there's no tool to orchestrate the retry (re-run entry checks, clear old evidence). Also no tool to fully reset a cycle.

**Implementation vision:** Add two new MCP tools in `src/tools/recovery.ts`:

`cycle_reset` — parameters: `{ confirm: boolean }`. If confirm is false, return a preview of what would be lost (cycle_id, progress summary, evidence count). If confirm is true: delete state.json, delete all evidence files in `.rigor/evidence/`, return confirmation. Does NOT delete config.

`task_retry` — parameters: `{ task_id: string }`. Validates task is in "failed" status. Clears the task's gate_0 evidence (delete file, reset gate_0 field in state). Transitions task back to "pending" (not "doing" — the agent must call task_start again to re-enter). Returns confirmation with the previous failure reason from evidence.

Register both tools in `src/server.ts` via a `registerRecoveryTools` function.

**Files:**
- Create: `src/tools/recovery.ts` (cycle_reset, task_retry handlers + registration)
- Modify: `src/server.ts` (register recovery tools)
- Create: `src/tools/__tests__/recovery.test.ts`

**Verification:** `npm test -- --reporter=verbose` — tests for: cycle_reset preview mode, cycle_reset confirm clears state and evidence, task_retry on non-failed task rejected, task_retry clears evidence and resets to pending, task_retry returns previous failure reason.

**Done when:** Both recovery tools work, cycle_reset has a safety confirmation gate, task_retry clears stale evidence and resets cleanly.

---

#### Task 4.2.3: Implement cycle_diagnose tool

- [ ] Done

**Context:** When a cycle is in a bad state, agents need a diagnostic tool that explains what's wrong and suggests next steps. This combines the validator from 4.2.1 with evidence auditing to give a complete health report.

**Implementation vision:** Add `cycle_diagnose` MCP tool in `src/tools/recovery.ts`. It: (1) loads state, (2) runs `validateState`, (3) runs `detectStuckEntities`, (4) audits evidence completeness — for every "done" task, check gate_0 evidence exists; for every "done" epic, check gate_8 and gate_9 evidence, (5) produces a human-readable diagnostic report: cycle health (healthy/degraded/corrupt), list of issues with severity (error/warning), list of stuck entities with suggested action ("run task_retry" or "run task_complete"), progress summary. No parameters needed.

**Files:**
- Modify: `src/tools/recovery.ts` (add cycle_diagnose)
- Modify: `src/tools/__tests__/recovery.test.ts` (add diagnose tests)

**Verification:** `npm test -- --reporter=verbose` — tests for: healthy cycle, stuck task detected with suggestion, missing evidence warned, corrupt state errors listed.

**Done when:** Diagnostic report accurately reflects cycle health, suggests concrete recovery actions.

---

### Epic 4.3: rigor:cycle skill and assistant integration

**Goal:** A workflow skill (`skills/cycle/SKILL.md`) that teaches AI agents how to use the MCP tools to drive a development cycle
**Scope:** `skills/cycle/`
**Dependencies:** Phase 3 (full cycle must work for the skill to reference)
**Done when:** the skill documents the full cycle workflow (init -> task_start -> task_complete -> review -> accept -> advance), includes anti-patterns for bypassing gates, and is pressure-tested with rigor:test-skill
**Status:** Pending

#### Task 4.3.1: Write the rigor:cycle skill

- [ ] Done

**Context:** The skill is a Markdown document that Claude Code loads as a system prompt when the agent is driving a development cycle. It must teach the agent the exact tool call sequence, what to do when gates fail, and what behaviors are prohibited. The skill follows the same format as existing skills in `skills/` (SKILL.md with frontmatter).

**Implementation vision:** Create `skills/cycle/SKILL.md` with:

1. **Frontmatter**: name, description, triggers (when user says "start dev cycle", "run the cycle", etc.)
2. **Workflow sequence**: `cycle_init(plan_path)` → for each task in phase: `task_start(task_id)` → implement → `task_complete(task_id)` → for each epic: `review_start(epic_id)` → `review_submit(epic_id, ...)` → `accept_start(epic_id)` → `accept_submit(epic_id, ...)` → `phase_advance()`
3. **Gate failure protocol**: When task_complete fails, read the evidence, fix the issue, call `task_retry` then restart. Never skip a failing gate.
4. **Anti-patterns** (explicit prohibitions): Do not edit `.rigor/state.json` directly. Do not call `task_complete` without running the actual implementation. Do not fabricate review submissions. Do not call `phase_advance` until all epics pass Gate 9.
5. **Recovery protocol**: If stuck, call `cycle_diagnose` first. Use `task_retry` for failed tasks. Use `cycle_reset` only as last resort (requires user confirmation).
6. **Status reporting**: After each gate, report results to the user. After each epic, show cumulative progress.

**Files:**
- Create: `skills/cycle/SKILL.md`

**Verification:** Manual review — skill covers the full lifecycle, anti-patterns are specific and actionable, recovery flows reference the correct tool names.

**Done when:** Skill document is complete, covers happy path, failure recovery, and prohibited behaviors.

---

## Self-Review

**Spec coverage:**

| Requirement | Covered by |
|-------------|------------|
| State machine with transitions | Epic 1.2 (state manager with validated transitions) |
| Gate entry/exit criteria enforcement | Epic 2.2 (Gate 0), Epics 3.1-3.2 (Gates 8/9) |
| Shell command execution (tests, lint, coverage) | Epic 2.1 (executor) |
| Evidence persistence | Epic 2.2 (Gate 0 evidence), Epics 3.1-3.2 (review/acceptance evidence) |
| Plan parsing | Epic 1.3 (plan parser) |
| Config loading | Epic 1.1 (config loader) |
| MCP protocol integration | Epic 1.4 (server bootstrap) |
| Custom gates | Epic 4.1 |
| Error recovery | Epic 4.2 |
| Agent-facing skill | Epic 4.3 |

No gaps.

**Vagueness scan:** All Phase 1 tasks specify exact file paths, implementation approach, and verification commands. No "appropriate", "TBD", or unnamed edge cases.

**Contract consistency:** `CycleState` types defined in Epic 1.2 are consumed by the state manager, plan parser (produces them), and all tools. `RigorConfig` from Epic 1.1 is consumed by the server and Gate 0. `ParsedPlan` from Epic 1.3 feeds into state initialization. All contracts are defined once.

**Phase boundaries:** Phase 1 ends with a running MCP server that initializes cycles and reports status. Phase 2 adds gate enforcement. Phase 3 completes the cycle. Phase 4 hardens for production. Each phase produces working, testable software.

**Verification plausibility:** All verification commands use `npm test`, `npm run build`, and `node dist/server.js` -- standard Node.js toolchain commands.
