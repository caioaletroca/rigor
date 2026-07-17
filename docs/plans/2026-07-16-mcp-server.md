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
**Scope:** `src/gates/`, `src/config/`
**Dependencies:** Phase 2 (Gate 0 pattern to extend)
**Done when:** custom gates with arbitrary shell commands run at configured positions in the cycle, Gate 1 triggers conditionally when new dependencies are introduced
**Status:** Pending

### Epic 4.2: Error recovery and state repair

**Goal:** The server recovers gracefully from crashes, interrupted cycles, and corrupted state
**Scope:** `src/state/`, `src/tools/`
**Dependencies:** Phase 3 (full state machine must exist)
**Done when:** server detects corrupted state on startup and offers repair, `cycle_reset` tool allows restarting a failed gate without losing the whole cycle, interrupted tasks can be retried
**Status:** Pending

### Epic 4.3: rigor:cycle skill and assistant integration

**Goal:** A workflow skill (`skills/cycle/SKILL.md`) that teaches AI agents how to use the MCP tools to drive a development cycle
**Scope:** `skills/cycle/`
**Dependencies:** Phase 3 (full cycle must work for the skill to reference)
**Done when:** the skill documents the full cycle workflow (init -> task_start -> task_complete -> review -> accept -> advance), includes anti-patterns for bypassing gates, and is pressure-tested with rigor:test-skill
**Status:** Pending

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
