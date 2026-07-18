# Impeccable Integration Plan

> **For implementers:** This is a rolling-wave plan. Phase 1 tasks are
> dispatch-ready. Later phases are epic-level only -- elaborate them against
> the real codebase when execution reaches them.
> This document is the living source of truth -- task elaboration for later
> phases is written back into it during execution.

**Goal:** Incorporate Impeccable (pbakaus/impeccable) as a design quality dependency in Rigor's software domain pack, adding deterministic design enforcement (detector), design context artifacts (PRODUCT.md/DESIGN.md), and AI-powered design review (audit/critique) to the gate system.

**Architecture:** Impeccable integrates at three layers, each mapping to a phase:

1. **Deterministic layer (Phase 1):** `npx impeccable detect src/` runs as a
   check in the software domain pack's `defaults.yaml`. It follows the generic
   check contract: command exits 0 (clean) or 1 (violations found). The React
   lang pack sets `${lang.design_command}` so the check only activates for
   frontend projects. The init skill detects Impeccable and wires the check
   into generated config.

2. **Context layer (Phase 2):** PRODUCT.md and DESIGN.md become first-class
   design artifacts. The init skill offers `impeccable init` during setup.
   Pre-dev and implementation skills consume design context for design-aware
   code generation.

3. **Judgment layer (Phase 3):** A `design-quality` reviewer agent joins Gate 8
   for frontend projects, using Impeccable's audit output plus AI judgment for
   subjective design quality issues the detector can't catch.

**Tech Stack:** TypeScript, MCP SDK, Impeccable CLI (`npx impeccable`), YAML

**Prerequisite:** Domain-agnostic core plan (`docs/plans/2026-07-17-domain-agnostic-core.md`) is fully implemented. The codebase has the generic `checks[]` system, the software domain pack at `skills/domain/software/`, lang pack variable resolution (`${lang.*}`), and the config cascade (core → domain pack → lang pack → user config).

**Key design decision — exit code, not metric:** Impeccable detect exits
0 (clean) or 1 (violations). This maps directly to the generic check's
pass/fail contract (exit code 0 = pass). We do NOT use the `metric` field
for violation counts because the metric system uses `value >= threshold`
comparison (designed for coverage-like metrics where higher is better).
Violation counts need `value <= threshold` (lower is better). Instead,
severity control is done via Impeccable's own config (`.impeccable/config.json`
ignore rules, inline waivers) — each tool owns its quality model, Rigor
just orchestrates the 0/1 result.

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | Impeccable detector runs as a check in the software domain pack — React projects get design quality enforcement via the generic check runner | 1.1, 1.2, 1.3 | Done |
| 2 | Design context artifacts (PRODUCT.md, DESIGN.md) integrated into init and pre-dev workflow | 2.1, 2.2 | Done |
| 3 | Design quality reviewer in Gate 8 uses Impeccable audit for AI-assisted design review | 3.1 | Done |

---

## Phase 1: Impeccable Detector Check

At the end of this phase, the software domain pack includes a `design-quality` check referencing `${lang.design_command}`. The React lang pack sets that variable to `npx impeccable detect src/`. The init skill detects Impeccable installation and configures the check. The generic check runner executes it — exit code 0 passes, exit code 1 fails. Evidence includes the detector's stdout (finding details).

---

### Epic 1.1: React Lang Pack Design Command

**Goal:** The React lang pack provides `${lang.design_command}` pointing to Impeccable's detector. The software domain pack references it as a check in `defaults.yaml`. The variable resolves to empty for non-React lang packs, so the check is skipped.
**Scope:** `skills/lang/react/`, `skills/domain/software/defaults.yaml`
**Dependencies:** Domain-agnostic core (generic checks, lang pack variables, domain pack loading)
**Done when:** A React project with Impeccable installed gets the design-quality check during Gate 0. A Go project does not. A React project without Impeccable installed gets a clear "not installed" failure (exit code 127) that the user can address.
**Status:** Done

#### Task 1.1.1: Add design_command to React lang pack

- [x] Done

**Context:** The React lang pack lives at `skills/lang/react/`. After the domain-agnostic plan, lang packs provide `${lang.*}` variables consumed by the software domain pack's `defaults.yaml`. The React lang pack already defines variables like `lang.test_command` and `lang.lint_command` for React-specific tooling.

**Implementation vision:** Add `design_command` to the React lang pack's variable definitions:

```yaml
design_command: "npx impeccable detect src/"
```

No `--json` flag here — the generic check runner captures stdout regardless, and human-readable output is better evidence for the agent to interpret. The `--json` flag would be used by a wrapper script if we needed structured parsing, but the exit code contract (0 = clean, 1 = violations) is sufficient for the check.

Only the React lang pack gets this variable. The Go, TypeScript (backend), Python, and C# lang packs do NOT define `design_command` — it resolves to empty, and the check runner skips checks with empty commands.

**Files:**
- Modify: `skills/lang/react/` (add `design_command` variable — exact file depends on how the domain-agnostic plan structured lang pack variable definitions; likely a `defaults.yaml` or similar)

**Verification:** Load config for a React project and verify `${lang.design_command}` resolves to `"npx impeccable detect src/"`. Load config for a Go project and verify it resolves to empty.

**Done when:** React lang pack provides `design_command`. Other lang packs do not.

---

#### Task 1.1.2: Add design-quality check to software domain pack

- [x] Done

**Context:** The software domain pack at `skills/domain/software/defaults.yaml` defines Gate 0 checks using `${lang.*}` variables. After the domain-agnostic plan, it has checks like:

```yaml
checks:
  - name: "tests"
    command: "${lang.test_command}"
    metric:
      parse: "${lang.coverage_pattern}"
      threshold: 85
      label: "coverage"
  - name: "lint"
    command: "${lang.lint_command}"
```

**Implementation vision:** Add the design-quality check to the Gate 0 checks array:

```yaml
  - name: "design-quality"
    command: "${lang.design_command}"
```

No `metric` field — enforcement is purely exit code. Impeccable exits 0 when clean, 1 when violations exist. The generic check runner treats exit 0 as pass, anything else as fail.

This check sits alongside tests and lint as a peer. When `${lang.design_command}` resolves to empty (non-React projects), the check runner skips it — same behavior as when a backend lang pack doesn't define `lint_command` and the lint check skips.

**Files:**
- Modify: `skills/domain/software/defaults.yaml` (add design-quality check to Gate 0 checks array)

**Verification:** Parse the YAML and verify the check appears. Verify variable placeholder syntax matches the resolver's expectations.

**Done when:** Software domain pack includes the design-quality check. YAML is valid.

---

#### Task 1.1.3: Document design-quality check in example config

- [x] Done

**Context:** `skills/config.example.yaml` is the annotated reference that users copy from. After the domain-agnostic plan, it shows the new `checks[]` format. The example needs to show how to configure the design-quality check, including how to override the command, how to disable it, and how to configure Impeccable's own settings.

**Implementation vision:** Add a commented section showing the design-quality check with guidance:

```yaml
      # Design quality (Impeccable detector)
      # Active for React/Next.js projects. Requires: npm i -D impeccable
      # Configure Impeccable itself via .impeccable/config.json:
      #   - ignore specific rules: detector.ignoreRules
      #   - ignore specific files: detector.ignoreFiles
      #   - ignore specific values: detector.ignoreValues (e.g. brand fonts)
      # Inline waivers: <!-- impeccable-disable rule-name: reason -->
      - name: "design-quality"
        command: "npx impeccable detect src/"
        # No metric — uses exit code: 0 = clean, 1 = violations
```

**Files:**
- Modify: `skills/config.example.yaml` (add design-quality check example with inline docs)

**Verification:** YAML parses without errors.

**Done when:** Example config documents the design-quality check, Impeccable setup, and severity control via Impeccable's own config.

---

### Epic 1.2: Init Skill Impeccable Detection

**Goal:** `rigor:init` detects Impeccable when initializing a React project and configures the design-quality check. If Impeccable isn't installed, it suggests adding it. If it is installed but PRODUCT.md doesn't exist, it offers to run `impeccable init`.
**Scope:** `skills/init/SKILL.md`
**Dependencies:** Epic 1.1 (the check definition must exist in the domain pack)
**Done when:** Running `rigor:init` on a React project with Impeccable installed generates config with the design-quality check active. On a React project without Impeccable, the init output suggests `npm i -D impeccable`.
**Status:** Done

#### Task 1.2.1: Add Impeccable detection to init skill

- [x] Done

**Context:** The init skill at `skills/init/SKILL.md` orchestrates project setup. After the domain-agnostic plan, it auto-detects the domain, selects the domain pack, detects the lang pack, and generates `.rigor/config.yaml` with merged defaults. The skill already detects React via signals like `next.config.*` and `.tsx/.jsx` files.

**Implementation vision:** Add an Impeccable detection step after lang pack detection, only for React projects:

1. Check if `npx impeccable --version` succeeds (exit code 0). This determines whether Impeccable is installed.
2. If installed:
   - Confirm the design-quality check is active in the generated config (it comes from the domain pack defaults via `${lang.design_command}`)
   - Check if `PRODUCT.md` exists in the project root. If not, inform the user: "Impeccable is installed but PRODUCT.md doesn't exist. Run `npx impeccable init` to set up your design context."
   - Check if `.impeccable/config.json` exists. If not, note it as optional but recommended for team-wide ignore rules.
3. If not installed:
   - Informational suggestion in the init output: "For design quality enforcement, install Impeccable: `npm i -D impeccable`. The design-quality gate check will activate automatically."
   - The design-quality check still appears in config but will fail gracefully (exit code 127 → command not found). The check runner reports it as a failed check, not a crash.

Do NOT make Impeccable installation mandatory. It's a suggestion, not a gate.

**Files:**
- Modify: `skills/init/SKILL.md` (add Impeccable detection section)

**Verification:** Run the init skill mentally through three scenarios: (1) React project + Impeccable installed + PRODUCT.md exists → clean setup, (2) React project + Impeccable installed + no PRODUCT.md → suggestion to run init, (3) React project + no Impeccable → suggestion to install.

**Done when:** Init skill detects Impeccable and provides appropriate guidance for all three scenarios.

---

### Epic 1.3: Graceful Command-Not-Found Handling

**Goal:** The generic check runner handles "command not found" (exit code 127) with a clear, actionable message instead of a cryptic error. This matters because the design-quality check is in the domain pack defaults but Impeccable may not be installed.
**Scope:** `src/gates/gate0.ts` (the generic check runner after domain-agnostic plan)
**Dependencies:** Domain-agnostic core (generic check runner must exist)
**Done when:** A check that fails with exit code 127 reports "Command not found: <command>. Install the tool or remove this check from config." instead of raw stderr. All existing tests still pass.
**Status:** Done

#### Task 1.3.1: Add command-not-found detection to generic check runner

- [x] Done

**Context:** After the domain-agnostic plan, Gate 0 loops over `checks[]` and runs each command via `runCommand()`. When a command isn't installed, `runCommand` returns exit code 127 (Unix convention for "command not found") with stderr like "npx: command 'impeccable' not found" or "bash: impeccable: command not found".

**Implementation vision:** In the check result builder (inside the checks loop in `src/gates/gate0.ts`), add a special case for exit code 127:

```
if (result.exit_code === 127) {
  // Extract the command name from the check for a helpful message
  checks.push({
    name: check.name,
    passed: false,
    detail: `Command not found: "${check.command}". Install the required tool or remove this check from your config.`,
    command: check.command,
    exit_code: 127,
    duration_ms: result.duration_ms,
  });
}
```

This is a general improvement — it helps with any missing tool, not just Impeccable. A user who configures a `pyright` check but doesn't have pyright installed gets the same clear message.

The check still fails (`passed: false`). The user can remove the check from their `.rigor/config.yaml` if they don't want it, or install the tool. This is correct — the domain pack suggests defaults, the user's config overrides.

**Files:**
- Modify: `src/gates/gate0.ts` (add exit code 127 handling in the checks loop)

**Verification:** Unit test: run a check with a command that returns exit code 127. Assert the detail message contains "Command not found" and the original command string. Existing tests still pass.

**Done when:** Exit code 127 produces a clear message. Existing behavior unchanged for other exit codes.

---

#### Task 1.3.2: Test the design-quality check end-to-end

- [x] Done

**Context:** The generic check runner has tests for check execution. This task adds test cases specific to the Impeccable integration path to verify the full flow from config to evidence.

**Implementation vision:** Add test cases to the existing Gate 0 test file:

1. **Design-quality check passes:** Config has `checks: [{ name: "design-quality", command: "echo 'No issues found'" }]`. Assert: check passes, detail includes stdout.
2. **Design-quality check fails:** Config has `checks: [{ name: "design-quality", command: "echo 'P0: overused-font in src/Button.tsx:5' && exit 1" }]`. Assert: check fails, detail includes the finding output.
3. **Design-quality check skipped (empty command):** Config has `checks: [{ name: "design-quality", command: "" }]`. Assert: check is skipped (not included in results, or included with a "skipped" status).
4. **Design-quality check with command not found:** Config has `checks: [{ name: "design-quality", command: "npx impeccable detect src/" }]`, mock `runCommand` to return exit code 127. Assert: check fails with "Command not found" detail.

**Files:**
- Modify: `src/gates/__tests__/gate0.test.ts` (add design-quality integration test cases)

**Verification:** `npm test` — all new and existing tests pass.

**Done when:** Four scenarios tested. All pass.

---

## Phase 2: Design Context Bridge

At the end of this phase, Rigor's workflow produces and consumes Impeccable's design context files. PRODUCT.md captures product strategy and audience (target users, brand voice, visual references, anti-references). DESIGN.md captures the visual system (palette, typography, spacing, components). These files are generated during project init and pre-dev planning, then consumed by frontend implementation skills for design-aware code generation.

---

### Epic 2.1: Init Skill Impeccable Setup Flow

**Goal:** When `rigor:init` detects Impeccable is installed and PRODUCT.md doesn't exist, it guides the user through `impeccable init` to generate PRODUCT.md. When DESIGN.md doesn't exist, it notes this as a future step (generated after initial design work via `impeccable document`).
**Scope:** `skills/init/SKILL.md`, design context detection
**Dependencies:** Phase 1 (detection logic exists)
**Done when:** Init flow for React+Impeccable projects produces a working PRODUCT.md. The generated config references PRODUCT.md as a project artifact.
**Status:** Done

**Implementation notes:** Added Step 3b to `skills/init/SKILL.md` with full Impeccable detection flow: installation check, PRODUCT.md/DESIGN.md/config.json presence detection, interactive `impeccable init` guidance when PRODUCT.md is missing, and config generation with `design_command`. Updated verification step to include `design_command`.

---

### Epic 2.2: Design Context in Pre-Dev and Implementation Skills

**Goal:** Pre-dev planning skills check for PRODUCT.md/DESIGN.md and reference them when creating PRDs and TRDs. Frontend implementation skills read `.impeccable/design.json` to apply the project's design tokens (palette, type scale, spacing) instead of generic defaults.
**Scope:** Pre-dev skills, frontend implementation skills, design context reading
**Dependencies:** Epic 2.1 (design context files must exist)
**Done when:** PRD creation references PRODUCT.md for audience and positioning. Frontend engineer agent reads DESIGN.md for design tokens and uses them in generated components. Design-aware generation is demonstrably different from default generation (uses project colors, not generic purple-gradient).
**Status:** Done

**Implementation notes:** Added "Design Context Consumption" section to `skills/lang/react/SKILL.md` with detailed tables for how PRODUCT.md and DESIGN.md are consumed by PRD creation, TRD creation, implementation, and review phases. Includes concrete before/after examples (colors, typography, spacing, copy) showing how design-aware generation differs from default.

---

## Phase 3: Design Quality Reviewer

At the end of this phase, Gate 8 includes a `design-quality` reviewer in the software domain pack's reviewer set. This reviewer runs `impeccable audit` to get structured quality scores across 5 dimensions (accessibility, performance, theming, responsive, anti-patterns), then applies AI judgment for subjective design quality — layout rhythm, visual hierarchy, whitespace balance, component composition — grounded in the project's DESIGN.md.

---

### Epic 3.1: Design Quality Reviewer Agent

**Goal:** A `design-quality` reviewer SKILL.md exists in `skills/domain/software/reviewers/`. It runs during Gate 8 for projects with DESIGN.md. Findings follow the same severity format as other reviewers. The reviewer is in the default reviewer list but not in `required_reviewers`.
**Scope:** `skills/domain/software/reviewers/design-quality.md` (new), `skills/domain/software/defaults.yaml` (add to reviewer list)
**Dependencies:** Phase 2 (DESIGN.md and PRODUCT.md must be consumable)
**Done when:** Gate 8 dispatches a `design-quality` reviewer alongside code-quality, security, etc. The reviewer produces actionable findings grounded in the project's DESIGN.md and Impeccable's audit scores — specific rule violations, contrast issues, spacing inconsistencies, component composition problems. Not in `required_reviewers` by default.
**Status:** Done

**Implementation notes:**
- Added `design-quality` to `DEFAULTS.gates.gate_8.reviewers` in `src/config/schema.ts` (not in `required_reviewers`)
- Added design-quality reviewer definition to `skills/review/SKILL.md`: Available Reviewers table, Reviewer Categories, additional context section with Impeccable audit integration and DESIGN.md/PRODUCT.md consumption
- Added "Patterns: design-quality" section to `skills/lang/react/SKILL.md` covering: design token violations, component composition issues, visual hierarchy, responsive design, and accessibility-in-design patterns
- Added 4 tests to `src/gates/__tests__/gate8.test.ts`: design-quality findings counted in severity totals, design-quality not required by default, design-quality in default reviewers, design-quality not in default required_reviewers
- Updated `skills/config.example.yaml` to document the design-quality reviewer
