# Domain-Agnostic Core Implementation Plan

> **For implementers:** This is a rolling-wave plan. Phase 1 tasks are
> dispatch-ready. Later phases are epic-level only -- elaborate them against
> the real codebase when execution reaches them.
> This document is the living source of truth -- task elaboration for later
> phases is written back into it during execution.

**Goal:** Generalize Rigor's MCP gate server from a software-specific dev cycle tool into a domain-agnostic agentic project orchestrator with pluggable domain packs.

**Architecture:** Replace hardcoded gate fields (`test_command`, `lint_command`, `coverage_threshold`) with a generic `checks[]` array where each check is `{ name, command, metric? }`. Domain packs provide default checks via `defaults.yaml`. Config loader merges: core defaults → domain pack defaults → user `.rigor/config.yaml`. Backward compatibility maps old field names to the new format.

**Tech Stack:** TypeScript, MCP SDK, YAML parsing, Vitest

**Design doc:** `docs/designs/2026-07-17-domain-agnostic-core.md`

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | Generic check runner works — Gate 0 runs `checks[]` array, old config format still accepted | 1.1, 1.2, 1.3 | Detailed |
| 2 | Domain packs load — software domain pack provides defaults, init skill detects domain | 2.1, 2.2 | Epic-level |
| 3 | Frontend gates absorbed — Gates 2-5 become domain pack checks, not hardcoded gates | 3.1, 3.2 | Epic-level |

---

## Phase 1: Generic Check Runner

At the end of this phase, Gate 0 accepts both the old `{ test_command, lint_command, coverage_threshold }` format and the new `{ checks: [{ name, command, metric? }] }` format. The gate runner loops over the checks array. All existing tests pass. The old config format is mapped to the new format during loading.

---

### Epic 1.1: Generic Check Type and Config Schema

**Goal:** The config schema supports the new `Check` and `Metric` types alongside existing fields, with a migration function that maps old fields to new format.
**Scope:** `src/config/schema.ts`, `src/config/loader.ts`
**Dependencies:** none
**Done when:** `loadConfig()` returns a config where `gates.gate_0.checks` is always populated — either from new-format YAML or migrated from old-format fields. Existing tests that use old-format config still pass.
**Status:** Pending

#### Task 1.1.1: Add Check and Metric types to config schema

- [ ] Done

**Context:** `src/config/schema.ts` defines `Gate0Config` at lines 24-29 with four typed fields: `coverage_threshold`, `lint_command`, `test_command`, `require_test_files`. These are software-specific. The `DEFAULTS` object at lines 105-182 provides default values for all gates.

**Implementation vision:** Add two new interfaces above `Gate0Config`:

- `Metric`: `{ parse: string; threshold: number; label: string }` — regex to extract a number from stdout, threshold to compare, human label for evidence
- `Check`: `{ name: string; command: string; metric?: Metric }` — the universal gate check primitive

Add a `checks` field to `Gate0Config` (type `Check[]`, default `[]`). Keep the old fields (`test_command`, `lint_command`, `coverage_threshold`, `require_test_files`) so existing configs don't break — they'll be migrated in the loader. Update `DEFAULTS.gates.gate_0` to include `checks: []`.

**Files:**
- Modify: `src/config/schema.ts:24-29` (Gate0Config interface)
- Modify: `src/config/schema.ts:128-133` (DEFAULTS.gates.gate_0)

**Verification:** `npm run build` compiles without errors. Existing tests pass (`npm test`).

**Done when:** `Check` and `Metric` interfaces exist. `Gate0Config` has a `checks` field. Build succeeds.

---

#### Task 1.1.2: Add migration function in config loader

- [ ] Done

**Context:** `src/config/loader.ts` loads `.rigor/config.yaml`, deep-merges with DEFAULTS (lines 61-100), and returns the result. The `deepMerge` function at lines 22-40 handles recursive object merging and array replacement.

**Implementation vision:** Add a `migrateGate0Config(config: RigorConfig): RigorConfig` function called after `deepMerge` in `loadConfig()`. This function checks: if `gates.gate_0.checks` is empty AND the old fields (`test_command`, `lint_command`) are non-empty, build the `checks` array from them:

1. If `test_command` is non-empty → push a check `{ name: "tests", command: test_command }`. If `coverage_threshold` > 0, add `metric: { parse: <auto-detect pattern>, threshold: coverage_threshold, label: "coverage" }`. For the parse regex, use a generic pattern that matches the last percentage in output (same logic as `parseCoverage` auto mode in `src/executor/coverage.ts:61-65`).
2. If `lint_command` is non-empty → push `{ name: "lint", command: lint_command }`.

This means users with old configs get the same behavior without changing their YAML. Users writing new configs use `checks[]` directly and the old fields are ignored.

**Files:**
- Modify: `src/config/loader.ts` (add `migrateGate0Config`, call it in `loadConfig` after merge)

**Verification:** Write a test in `src/config/__tests__/loader.test.ts` that loads an old-format config (with `test_command` and `lint_command`) and asserts `gates.gate_0.checks` is populated with the correct check objects. Write a second test that loads a new-format config (with `checks[]`) and asserts the old fields are ignored.

**Done when:** Old-format configs produce a populated `checks` array. New-format configs pass through unchanged. Both formats tested.

---

#### Task 1.1.3: Update example config with new format

- [ ] Done

**Context:** `skills/config.example.yaml` at lines 58-83 shows the old Gate 0 config format with `coverage_threshold`, `lint_command`, `test_command`. This is the reference users copy from.

**Implementation vision:** Add a commented section below the existing Gate 0 config showing the new `checks[]` format. Keep the old format section with a comment noting it still works for backward compatibility. Show both a software example (tests + lint) and a generic example (any command).

**Files:**
- Modify: `skills/config.example.yaml:58-83`

**Verification:** YAML parses without errors: `node -e "require('yaml').parse(require('fs').readFileSync('skills/config.example.yaml','utf8'))"`

**Done when:** Example config documents both formats with clear comments.

---

### Epic 1.2: Generic Gate 0 Runner

**Goal:** Gate 0 iterates over the `checks[]` array instead of hardcoded `test_command`/`lint_command` logic. Each check runs its command, checks exit code, optionally parses a metric via regex, and compares to threshold.
**Scope:** `src/gates/gate0.ts`, `src/executor/coverage.ts`
**Dependencies:** Epic 1.1 (the `Check` type and migration must exist)
**Done when:** Gate 0 passes for a config using the new `checks[]` format. Gate 0 still passes for old-format configs (migrated by the loader). Evidence includes per-check results with metric values where applicable.
**Status:** Pending

#### Task 1.2.1: Add generic metric parser

- [ ] Done

**Context:** `src/executor/coverage.ts` currently has format-specific parsers (`parseGo` at line 22, `parseJest` at line 34, `parseLcov` at line 53, `parseGeneric` at line 61) and a `parseCoverage` dispatcher at lines 80-90. The new system needs a single `parseMetric(stdout: string, regex: string): number | null` function that applies an arbitrary user-supplied regex.

**Implementation vision:** Add `parseMetric(output: string, pattern: string): number | null` to `coverage.ts` (or rename the file to `metric.ts` — the coverage-specific name is now too narrow). The function compiles the regex from `pattern`, runs it against `output`, extracts the first capture group, and returns `parseFloat`. Returns `null` if no match. Keep the existing `parseCoverage` function unchanged — it's used by the migration path where old configs don't specify a regex.

**Files:**
- Modify: `src/executor/coverage.ts` (add `parseMetric`, export it)

**Verification:** Unit test: `parseMetric("convergence: 0.98", "convergence:\\s+(\\d+\\.?\\d*)")` returns `0.98`. Another: `parseMetric("Total: 85.3%", "Total:\\s+(\\d+\\.?\\d*)%")` returns `85.3`. Edge case: invalid regex returns `null` without throwing.

**Done when:** `parseMetric` works for arbitrary user-supplied regexes. Existing `parseCoverage` is untouched.

---

#### Task 1.2.2: Rewrite Gate 0 to iterate checks array

- [ ] Done

**Context:** `src/gates/gate0.ts` at lines 36-147 has `checkGate0Exit()` which runs hardcoded steps: test_command (lines 64-106), lint_command (lines 112-126), then test_files check (lines 132-138). Each step is a separate block with its own logic for running the command and building the `CheckResult`.

**Implementation vision:** Replace the body of `checkGate0Exit` with a loop over `config.gates.gate_0.checks`. For each check:

1. Run `runCommand(check.command, projectRoot)` (imported from `src/executor/runner.ts`)
2. Build a `CheckResult` with `name: check.name`, `passed: result.exit_code === 0`, `command: check.command`, `exit_code: result.exit_code`, `duration_ms: result.duration_ms`
3. If `check.metric` is defined AND the command passed: call `parseMetric(result.stdout + result.stderr, check.metric.parse)`. If the parsed value is not null, compare against `check.metric.threshold`. Set `passed` to `value >= threshold`. Add `detail: "${check.metric.label}: ${value} (threshold: ${threshold})"`.
4. Push the `CheckResult` to the array.

The `Gate0Result` interface stays the same — `{ passed, checks, coverage? }`. For backward compat, if any check has `metric.label === "coverage"`, populate the `coverage` field.

Handle the `require_test_files` flag as a special non-command check (it's a filesystem scan, not a command). Keep it at the end, same as today.

**Files:**
- Modify: `src/gates/gate0.ts:36-147` (rewrite `checkGate0Exit`)

**Verification:** Existing gate0 tests still pass (the migration converts old config to checks array, so the runner sees the same commands). Add a new test with a checks-array config containing a metric and verify the threshold comparison works.

**Done when:** Gate 0 loops over `checks[]`. Old configs work via migration. Metric parsing and threshold comparison work. All tests pass.

---

#### Task 1.2.3: Update gate tools to pass checks through

- [ ] Done

**Context:** `src/tools/gate.ts` at lines 169-439 handles `task_complete`. It calls `checkGate0Exit(config, projectRoot)` at line 204 and processes the result. The response message at lines 411-438 formats check results for the agent.

**Implementation vision:** Minimal changes needed here. The `checkGate0Exit` function signature and return type (`Gate0Result`) stay the same — only its internals changed in Task 1.2.2. Verify that the response formatting at lines 411-438 still works correctly since `CheckResult` objects now come from the generic runner. The `name` field on each `CheckResult` used to be hardcoded ("tests", "lint", "coverage") — now it comes from the check config, which means it could be anything ("simulation", "equations"). The formatting code should already handle arbitrary names since it just prints `check.name`.

Review and adjust if any hardcoded check name assumptions exist in the response builder.

**Files:**
- Modify: `src/tools/gate.ts:411-438` (review response formatting, adjust if needed)

**Verification:** Run the full test suite. Deploy the MCP server locally, run `task_complete` with a test project using old-format config. Verify the response includes check names and metric details.

**Done when:** Task complete works end-to-end with the generic check runner. No hardcoded check name assumptions in the response.

---

### Epic 1.3: Tests and Evidence

**Goal:** The test suite covers both old-format and new-format configs through Gate 0. Evidence files include metric data when checks define metrics.
**Scope:** `src/gates/__tests__/`, `src/tools/__tests__/`
**Dependencies:** Epics 1.1 and 1.2
**Done when:** Test coverage for the generic check runner matches or exceeds the old hardcoded gate tests. Evidence JSON files include metric values and labels.
**Status:** Pending

#### Task 1.3.1: Add gate0 tests for generic check runner

- [ ] Done

**Context:** `src/gates/__tests__/` contains existing gate tests. The current gate0 tests exercise the hardcoded test/lint/coverage flow.

**Implementation vision:** Add new test cases in the gate0 test file:

1. **New-format config with metric:** Config has `checks: [{ name: "sim", command: "echo 'convergence: 0.98'", metric: { parse: "convergence:\\s+(\\d+\\.?\\d*)", threshold: 0.95, label: "convergence" }}]`. Assert: passes, check has `detail` containing "convergence: 0.98", `Gate0Result.coverage` is undefined (label isn't "coverage").
2. **New-format config with failing metric:** Same check but threshold 0.99. Assert: fails, detail explains shortfall.
3. **New-format config with command-only check:** `checks: [{ name: "lint", command: "exit 0" }]`. Assert: passes with no metric.
4. **New-format config with failing command:** `checks: [{ name: "lint", command: "exit 1" }]`. Assert: fails.
5. **Empty checks array:** Assert: passes trivially (same as current empty-command behavior).
6. **Old-format config (migration test):** Config has `test_command: "echo ok"`, `lint_command: "echo clean"`. Assert: checks array populated by migration, gate passes.

**Files:**
- Modify: `src/gates/__tests__/gate0.test.ts` (add new test cases)

**Verification:** `npm test` — all new and existing tests pass.

**Done when:** Six new test cases covering the generic check runner. All pass.

---

#### Task 1.3.2: Verify evidence includes metric data

- [ ] Done

**Context:** `src/evidence/manager.ts` saves gate evidence as JSON with a `checks` array. The `CheckResult` type includes `name`, `passed`, `detail`, `command`, `exit_code`, `duration_ms`. Metric data (parsed value, threshold, label) needs to appear in the `detail` field.

**Implementation vision:** No code changes needed if Task 1.2.2 puts metric info into `CheckResult.detail`. Write a test that runs Gate 0 with a metric check, saves evidence via `EvidenceManager`, loads the evidence file, and asserts the `detail` field contains the metric label and value.

**Files:**
- Modify: `src/gates/__tests__/gate0.test.ts` or `src/evidence/__tests__/manager.test.ts` (add evidence round-trip test)

**Verification:** `npm test` passes. Evidence JSON contains metric data.

**Done when:** Evidence files include metric labels, parsed values, and thresholds in the detail field.

---

## Phase 2: Domain Pack System

At the end of this phase, Rigor loads domain-specific defaults from `skills/domain/<name>/defaults.yaml`. The software domain pack exists and provides the same defaults currently hardcoded in the schema. The `rigor:init` skill detects the project domain and generates config accordingly.

---

### Epic 2.1: Domain Pack Loading

**Goal:** Config loader discovers and loads domain pack `defaults.yaml`, merges it into the config cascade between core defaults and user config.
**Scope:** `src/config/loader.ts`, `src/config/schema.ts`, `skills/domain/software/`
**Dependencies:** Phase 1 (generic check format must exist)
**Done when:** A project with `domain: software` in `.rigor/config.yaml` gets software-specific defaults (test, lint, coverage checks) from the domain pack. A project with no domain setting gets core defaults only.
**Status:** Pending

*(No tasks yet -- elaborated during execution after Phase 1 lands.)*

---

### Epic 2.2: Init Skill Domain Detection

**Goal:** `rigor:init` auto-detects the project domain, presents a recommendation with override option, and generates config with domain-appropriate defaults.
**Scope:** `skills/init/SKILL.md`, `skills/domain/software/DOMAIN.md`
**Dependencies:** Epic 2.1 (domain pack loading must work)
**Done when:** Running `rigor:init` on a Go project detects "software" domain, presents the recommendation, and generates `.rigor/config.yaml` with software domain defaults including Go lang pack commands.
**Status:** Pending

*(No tasks yet -- elaborated during execution after Phase 1 lands.)*

---

## Phase 3: Absorb Frontend Gates

At the end of this phase, Gates 2-5 (accessibility, visual, e2e, performance) are no longer hardcoded gate implementations. They become checks in the software domain pack's `defaults.yaml`, running through the same generic check runner as Gate 0. The separate `gate2.ts` through `gate5.ts` files are removed.

---

### Epic 3.1: Migrate Frontend Gates to Domain Pack Checks

**Goal:** Frontend quality checks (axe-core, visual tests, playwright, lighthouse) defined as checks in the software domain pack defaults, not as separate TypeScript gate implementations.
**Scope:** `src/gates/gate2-5.ts`, `src/tools/gate.ts`, `skills/domain/software/defaults.yaml`
**Dependencies:** Phase 2 (domain pack loading must work)
**Done when:** `gate2.ts` through `gate5.ts` are deleted. Frontend checks run through the generic Gate 0 check runner. The software domain pack's `defaults.yaml` defines these checks with their detection conditions, commands, and thresholds.
**Status:** Pending

*(No tasks yet -- elaborated during execution after Phase 2 lands.)*

---

### Epic 3.2: Update Documentation

**Goal:** All documentation reflects the domain-agnostic identity — "project cycle" not "dev cycle", domain packs documented, gate descriptions generalized.
**Scope:** `docs/architecture.md`, `docs/gates.md`, `docs/why-rigor.md`, `README.md`
**Dependencies:** Epic 3.1
**Done when:** No documentation refers to Rigor as software-only. Domain pack system documented. Gate descriptions use generic language with software as an example domain.
**Status:** Pending

*(No tasks yet -- elaborated during execution after Epic 3.1 lands.)*
