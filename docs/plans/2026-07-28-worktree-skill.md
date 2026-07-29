# Domain-Scoped Worktree Skill Implementation Plan

> **For implementers:** This is a rolling-wave plan. Phase 1 tasks are
> dispatch-ready. Later phases are epic-level only -- elaborate them against
> the real codebase when execution reaches them.
> This document is the living source of truth -- task elaboration for later
> phases is written back into it during execution.

**Goal:** Ship `rigor:worktree`, a git-worktree standard + usage skill that lives *inside* the software domain pack and installs as a slash command only when the software domain is active.

**Architecture:** Introduces a new convention -- a domain pack MAY carry invokable skills under `skills/domain/<domain>/skills/<name>/SKILL.md`. The `install_commands` MCP tool (which has `projectRoot` and can read the active `domain:` via `loadConfig`) discovers these and installs them as slash commands gated on the project's active domain; global installs surface all domain-scoped skills. `install.mjs` (the global skill-symlink installer, no project context) discovers and symlinks them unconditionally so the Skill tool can also find them. The skill's content merges ring's `using-git-worktrees` (non-negotiables, red flags, pressure resistance) with `creating-worktrees` (the directory-priority -> .gitignore-safety -> dep-install -> baseline-test workflow), adapted to Rigor (config-aware directory priority, baseline test reuses the configured Gate 0 test command, integrates with rigor:plan/cycle/ship).

**Tech Stack:** TypeScript 5.7 (ESM), Node 20+, Vitest 3, `@modelcontextprotocol/sdk`, `yaml`. `install.mjs` is plain ESM (no TypeScript).

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | `rigor:worktree` exists in the software pack, installs as a domain-gated slash command via `install_commands`, AND is symlinked by `install.mjs` so the agent can auto-invoke it via the Skill tool | 1.1, 1.2, 1.3 | Detailed |
| 2 | The skill and the domain-scoped-skill convention are documented (README/DOMAIN.md) and dogfooded on Rigor's own repo | 2.1 | Epic-level |

---

## Phase 1 -- Skill authored + both install surfaces (slash command + auto-discoverable Skill)

### Epic 1.1: Author the `rigor:worktree` skill inside the software domain pack

**Goal:** A complete, self-contained `skills/domain/software/skills/worktree/SKILL.md` exists, merging ring's worktree standard and usage, adapted to Rigor and made multi-agent-safe; the software pack's `DOMAIN.md` documents that the pack now ships this skill.
**Scope:** `skills/domain/software/`
**Dependencies:** none
**Done when:** the SKILL.md exists with valid frontmatter (`name: rigor:worktree`, single-line `description`), covers directory-priority selection, .gitignore safety, dependency install, baseline-test verification, non-negotiables, a **Concurrency / multiple agents** section (unique path+branch derivation, one-agent-per-worktree, `git worktree list` pre-check, reconverge ordering), and Rigor integration; `DOMAIN.md` has a section naming the shipped skill.
**Status:** Pending

#### Task 1.1.1: Write the worktree SKILL.md

- [ ] Done

**Context:** Rigor has zero worktree material today (`grep -rniE "worktree" skills/` returns nothing). The source material is two ring skills on disk: the *standard* at `C:/Users/caio_/.claude/plugins/marketplaces/ring/default/skills/using-git-worktrees/SKILL.md` (non-negotiables, red flags, pressure-resistance and anti-rationalization tables, severity calibration) and the *workflow* at `C:/Users/caio_/.claude/skills/creating-worktrees.backup_20260723_101443/SKILL.md` (directory priority -> .gitignore safety -> dep install -> baseline test). Existing Rigor skills are single SKILL.md files with an announce line and terse tables; see `skills/commit/SKILL.md` and `skills/explore/SKILL.md` for house voice, and `skills/domain/software/DOMAIN.md` for how the pack references lang-pack variables (`${lang.*}`).

**Implementation vision:** Create the skill by merging the two ring sources, not copying either verbatim. Frontmatter: `name: rigor:worktree` and a single-line `description:` in the detailed style Rigor uses (the `install_commands` frontmatter parser at `src/tools/scaffold.ts:188-215` handles single-line descriptions; `parseSkillFrontmatter` splits the first `". "` for the slash-command blurb, so lead with a self-contained first sentence). Announce line: `Using rigor:worktree to set up an isolated workspace.` Body sections, adapted to Rigor:
- **When to use / Skip when** -- carry over ring's trigger/skip lists.
- **Directory selection (priority order)** -- Rigor-adapted tiers: (1) existing `.worktrees/` or `worktrees/` (prefer `.worktrees/`); (2) `.rigor/config.yaml` `worktree.directory` if present (grep the yaml, no schema code -- this is a documented optional key, not a loader change); (3) `CLAUDE.md` preference; (4) ask the user (`.worktrees/` project-local vs `~/.config/rigor/worktrees/<project>/` global). Note the global path uses `rigor`, not `ring`.
- **Safety verification** -- project-local directories MUST be in `.gitignore` before creation (`grep -q "^\.worktrees/$\|^worktrees/$" .gitignore`); if absent, add and commit before proceeding. Global directory needs no verification. This is CRITICAL and non-waivable.
- **Creation steps** -- detect project name, `git worktree add "$path" -b "$BRANCH" && cd "$path"`, dependency install auto-detected from project files.
- **Baseline verification (Rigor-native)** -- prefer the project's configured Gate 0 test command from `.rigor/config.yaml` (`gates.gate_0.test_command`, or the `checks[]` test entry) when present; fall back to auto-detection (`go test ./...`, `npm test`, `pytest`, `cargo test`) otherwise. Failing baseline -> STOP and report (cannot distinguish pre-existing from new breakage). This is the Rigor differentiator vs ring -- state it explicitly.
- **Concurrency / multiple agents (Rigor-native, not in ring)** -- the rules that let several agents work the same repo without colliding. State each explicitly: (1) **one agent per worktree** -- an agent never operates in a worktree another agent created; (2) **unique path + branch per unit of work** -- derive the worktree path and branch from the task/feature identifier (e.g. `.worktrees/<task-id>` + `feat/<task-id>`) so two agents cannot compute the same name; (3) **pre-create check** -- run `git worktree list` (and `git branch --list`) before `git worktree add`, and if the path or branch already exists, do NOT reuse it -- pick a fresh suffix or STOP and report (never `cd` into a worktree you did not just create); (4) **git serializes racers** -- `git worktree add <path> -b <branch>` hard-fails if the path or branch already exists, so on that specific error, treat it as a name collision and retry with a unique name rather than assuming corruption; (5) **reconverge ordering** -- each agent lands its own branch via its own PR (`rigor:ship`/`rigor:pr`); worktrees are never merged into each other directly, and cleanup (`git worktree remove`) happens only after that branch's PR is merged. Present this as a short subsection plus a one-line rule table.
- **Quick reference / Non-negotiables / Red flags / Pressure resistance / Anti-rationalization** -- carry over ring's tables, trimmed to Rigor voice; add a non-negotiable for the one-agent-per-worktree + unique-name invariants.
- **Integration** -- runs before `rigor:cycle` / `rigor:plan` execution (isolated workspace for a plan), pairs with `rigor:ship` and `rigor:commit` for the eventual branch/cleanup.

**Files:**
- Create: `skills/domain/software/skills/worktree/SKILL.md`

**Verification:** `node -e "const c=require('fs').readFileSync('skills/domain/software/skills/worktree/SKILL.md','utf8'); if(!/^---[\s\S]*name:\s*rigor:worktree[\s\S]*?---/.test(c)) throw new Error('missing/invalid frontmatter'); if(!/worktree\.directory/.test(c)||!/gate_0|test_command/.test(c)) throw new Error('missing Rigor-native sections'); if(!/git worktree list/.test(c)||!/one agent per worktree/i.test(c)) throw new Error('missing concurrency rules'); console.log('SKILL.md OK')"` -- prints `SKILL.md OK`.

**Done when:** the file exists with `name: rigor:worktree` frontmatter, a leading self-contained description sentence, and all sections above, including the config-aware directory tier, the Gate-0-test baseline behavior, and the Concurrency / multiple agents rules.

#### Task 1.1.2: Document the shipped skill in the software DOMAIN.md

- [ ] Done

**Context:** `skills/domain/software/DOMAIN.md` currently documents only Gate 0 checks, detection signals, and lang packs. Domain packs have never shipped an invokable skill before, so nothing describes that capability. `DOMAIN.md` is read by `skills/init/SKILL.md:58` when scanning domain packs.

**Implementation vision:** Add a short `## Domain Skills` section stating that the software pack ships `rigor:worktree`, one line on what it does, and that it installs as a slash command only when `domain: software` is active (per the `install_commands` gating landing in Epic 1.2). Keep it a table row or two-line note matching the existing terse style -- do not restate the skill's content.

**Files:**
- Modify: `skills/domain/software/DOMAIN.md`

**Verification:** `grep -q "rigor:worktree" skills/domain/software/DOMAIN.md && echo OK` -- prints `OK`.

**Done when:** `DOMAIN.md` names `rigor:worktree` and states the domain-gated slash-command behavior.

---

### Epic 1.2: Discover and install domain-scoped skills via `install_commands` (domain-gated)

**Goal:** `install_commands` discovers skills under `skills/domain/<domain>/skills/*/SKILL.md` and installs them as `/rigor:<name>` slash commands, gated by the project's active `domain:` (global installs surface all of them); a pure, exported discovery helper is unit-tested against a fixture.
**Scope:** `src/tools/scaffold.ts`, `src/tools/__tests__/scaffold.test.ts`
**Dependencies:** Epic 1.1 (the skill must exist to be discovered; the fixture test creates its own)
**Done when:** with `domain: software` in `.rigor/config.yaml`, a per-project `install_commands` run produces a `rigor-worktree.md` command; with a different domain (or no domain) it does not; a global run always produces it; discovery unit tests pass; `npm run build` and `npm test` are green.
**Status:** Pending

#### Task 1.2.1: Add an exported `discoverDomainScopedSkills` helper

- [ ] Done

**Context:** `src/tools/scaffold.ts:217-246` has a private `discoverSkills(rigorRoot)` that scans top-level `skills/` and **explicitly skips `lang` and `domain`** (line 226). `parseSkillFrontmatter` (`scaffold.ts:188-215`) and the `SkillMeta` interface (`scaffold.ts:181-186`) already exist and are reusable. The existing pack-discovery pattern -- a pure function taking a root and returning discovered entries -- is at `src/scaffold/discovery.ts:104-131` (`discoverDomainPacks`) and is unit-tested directly against temp dirs. `install_commands` currently has no test coverage because `handleInstallCommands` reads the real Rigor root and writes to the real home dir; the testable seam is a pure discovery function, mirroring `discovery.ts`.

**Implementation vision:** Add and `export` a pure function `discoverDomainScopedSkills(rigorRoot: string, activeDomain: string | undefined, opts?: { global?: boolean }): SkillMeta[]`. It scans `skills/domain/`; for each domain dir it looks for a `skills/` subdir and, within it, each `<name>/SKILL.md`. Gating: when `opts.global` is true, include skills from every domain; otherwise include only skills whose domain equals `activeDomain` (and return `[]` when `activeDomain` is undefined). Reuse `parseSkillFrontmatter`; derive `name` (`fm.name ?? "rigor:" + leaf`), `shortName` (`name.replace(/^rigor:/,"").replace(/:/g,"-")`), `description`, and `skillPath` exactly as `discoverSkills` does. Sort by `shortName`. Do not change `discoverSkills`'s top-level behavior in this task -- only add the new function.

**Files:**
- Modify: `src/tools/scaffold.ts` (add exported function near `discoverSkills`, ~line 246)
- Test: `src/tools/__tests__/scaffold.test.ts` (new `describe("discoverDomainScopedSkills")` block)

**Verification:** `npx vitest run src/tools/__tests__/scaffold.test.ts` -- the new suite passes. Tests must cover: (a) a fixture root with `skills/domain/software/skills/worktree/SKILL.md` returns the skill when `activeDomain="software"`; (b) returns `[]` when `activeDomain="data-science"`; (c) returns `[]` when `activeDomain` is undefined and not global; (d) returns it when `opts.global` is true regardless of `activeDomain`.

**Done when:** the exported helper compiles, is covered by the four cases above, and `npm test` passes with coverage at or above the 85% Gate 0 threshold for the changed file.

#### Task 1.2.2: Wire domain-scoped skills into `handleInstallCommands` with domain gating

- [ ] Done

**Context:** `handleInstallCommands` (`src/tools/scaffold.ts:264-363`) calls `discoverSkills(rigorRoot)` (line 269), then writes one command file per skill -- `rigor-<shortName>.md` with an `@path` include for claude/opencode (`scaffold.ts:306-328`) or a copied `SKILL.md` for hermes (`scaffold.ts:291-305`), skipping files that already exist. `loadConfig(projectRoot)` returns a `RigorConfig` whose optional `.domain` field (`src/config/schema.ts:110-111`) names the active domain; it is imported elsewhere as `import { loadConfig } from "../config/index.js"` (see `src/server.ts:12`). The handler already receives `projectRoot` and `params.global`.

**Implementation vision:** In `handleInstallCommands`, after `const skills = discoverSkills(rigorRoot)`, resolve the active domain: `const activeDomain = params.global ? undefined : loadConfig(projectRoot).domain;` (wrap in try/catch -> undefined so a missing/invalid config never throws the install). Then `const domainSkills = discoverDomainScopedSkills(rigorRoot, activeDomain, { global: params.global });` and merge: `const allSkills = [...skills, ...domainSkills]`, de-duplicating by `shortName` with top-level skills winning (a domain skill whose `shortName` already exists among top-level skills is dropped). Iterate `allSkills` in place of `skills` for the write loop. Leave the empty-skills guard (`scaffold.ts:271-273`) keyed on the top-level `skills` array so behavior is unchanged when only domain skills exist is acceptable -- but prefer keying the guard on `allSkills.length === 0`. Do not change the command-file format or the hermes/claude/opencode branching.

**Files:**
- Modify: `src/tools/scaffold.ts:264-329`
- Test: `src/tools/__tests__/scaffold.test.ts` (extend; assert de-dup precedence in the discovery-level test since `handleInstallCommands` writes to the real home dir and is not unit-tested)

**Verification:** `npm run build && npm test` -- both succeed. Because `handleInstallCommands` writes to the real home directory, verify the gating manually per the epic Done-when after build; the automated coverage is the discovery-helper suite from Task 1.2.1 plus a de-dup precedence case.

**Done when:** `handleInstallCommands` includes domain-scoped skills gated by active domain (or all, when global), de-dupes by `shortName` with top-level precedence, never throws on a missing config, and the build + test suite pass.

### Epic 1.3: Symlink domain-scoped skills from `install.mjs`

**Goal:** The standalone installer symlinks domain-scoped skills into `~/.<assistant>/skills/` so the agent can auto-invoke `rigor:worktree` via the Skill tool, not only as a manual slash command.
**Scope:** `install.mjs`
**Dependencies:** Epic 1.1 (skill exists), Epic 1.2 (fixes the on-disk path convention and the leaf skill-name decision this must match)
**Done when:** `node install.mjs status` lists the worktree skill; a fresh `node install.mjs` creates the symlink; `node install.mjs uninstall` removes it; existing top-level and `lang/*` symlink behavior is unchanged.
**Status:** Pending

#### Task 1.3.1: Extend `install.mjs` discovery to reach domain-scoped skills

- [ ] Done

**Context:** `install.mjs` is a standalone ESM script (no TypeScript, runs pre-build) that symlinks each source skill dir into `~/.<assistant>/skills/<name>`. Its `discoverSkills()` (`install.mjs:41-64`) recurses only two levels: `skills/<name>/SKILL.md` (direct) and `skills/<ns>/<sub>/SKILL.md` named `<ns>-<sub>`. It does NOT reach `skills/domain/software/skills/worktree/SKILL.md` (four levels). `createSymlink` (`install.mjs:87-108`), `isRigorSymlink` (`install.mjs:110-117`, matches any target under `SKILLS_SOURCE`), and `uninstall` (`install.mjs:199-227`) all key off `SKILLS_SOURCE` -- domain-scoped skill dirs live under `SKILLS_SOURCE`, so uninstall/status detection keeps working with no change once discovery emits them. `install.mjs` is global and has no project/domain context, so it symlinks domain-scoped skills unconditionally; the domain gating is `install_commands`'s job (Epic 1.2), not this installer's.

**Implementation vision:** In `discoverSkills()`, after the existing two-level scan, add a targeted pass: for each domain dir under `skills/domain/<d>/`, if a `skills/` subdir exists, enumerate `skills/domain/<d>/skills/<name>/SKILL.md` and push `{ name: <name>, sourcePath }` using the **bare leaf name** (`worktree`) to match the `rigor:<leaf>` slash-command convention fixed in Epic 1.2. Guard against collision: if `<name>` already exists in the accumulated list (a top-level skill of the same name), skip it and `log` a warning -- top-level wins, consistent with Epic 1.2's de-dup rule. Do not alter the existing two-level loop's output.

**Files:**
- Modify: `install.mjs:41-64`

**Verification:** `node install.mjs status` -- output includes a `worktree` entry (as `installed` or `missing`, depending on whether install has run); then `node install.mjs` followed by `test -L ~/.claude/skills/worktree && echo LINKED` prints `LINKED`, and `node install.mjs uninstall` removes it (re-running `status` no longer lists it as installed). No pre-existing skill entry disappears from `status`.

**Done when:** `discoverSkills()` emits domain-scoped skills by bare leaf name with top-level-collision skipping, they symlink/uninstall correctly, and existing skill discovery is byte-for-byte unchanged. (`install.mjs` has no existing test harness; if the domain-scan logic is extracted into a small exported helper, add a unit test for it -- otherwise the runnable `status`/symlink checks above are the verification.)

---

## Phase 2 -- Documentation and dogfood

### Epic 2.1: Document and dogfood the skill on Rigor's own repo

**Goal:** README and pack docs reflect the new skill and the domain-scoped-skill convention, and Rigor's own repo is brought into compliance with the standard the skill enforces.
**Scope:** `README.md`, `.gitignore`, `docs/`
**Dependencies:** Epic 1.1, Epic 1.2
**Done when:** the README Skills table (`README.md:279-299`) and domain-pack section (`README.md:254-277`) mention `rigor:worktree` and that domain packs can ship domain-scoped skills; Rigor's `.gitignore` (currently only `node_modules/` and `dist/`) ignores `worktrees/` and `.worktrees/` -- the exact CRITICAL fix the skill mandates, since the repo already has an untracked `worktrees/` directory; running the skill against Rigor itself reports a clean, ignored, ready worktree.
**Status:** Pending

> Elaborated during execution (2026-07-29). Note: `rigor:cycle` parses the plan once at `cycle_init` and cannot ingest tasks added to a later phase mid-cycle (no reparse without `cycle_reset`), so these tasks were executed and gated at the epic level (Gate 8/9) rather than per-task Gate 0. Build + full test suite were re-verified green after the changes.

#### Task 2.1.1: Add `worktrees/` to `.gitignore` (dogfood the CRITICAL safety rule)

- [x] Done

**Context:** The repo had an untracked `worktrees/` directory but `.gitignore` listed only `node_modules/` and `dist/` -- the exact CRITICAL failure `rigor:worktree` guards against. This also broke `npm test`: Vitest's `src/` filter globbed a nested worktree copy whose broken test file errored at collection.

**Implementation:** Added `worktrees/` and `.worktrees/` to `.gitignore`. (Vitest exclusion of `worktrees/**` was handled separately via `vitest.config.ts` during Phase 1 gate setup.)

**Files:**
- Modify: `.gitignore`

**Verification:** `git check-ignore worktrees/ .worktrees/` returns both paths; `git status` no longer lists `worktrees/` as untracked. Confirmed.

**Done when:** `worktrees/` and `.worktrees/` are git-ignored. Met.

#### Task 2.1.2: Document `rigor:worktree` and the domain-scoped-skill convention in the README

- [x] Done

**Context:** The README Skills table listed only top-level skills, and the domain-pack section did not mention that packs can ship domain-scoped skills.

**Implementation:** Added a "Domain-scoped skills" subsection + `rigor:worktree` row after the Skills table, and a note in the Shipped domain packs section explaining that `skills/domain/<domain>/skills/` skills install only when that domain is active.

**Files:**
- Modify: `README.md`

**Verification:** `grep -c "rigor:worktree" README.md` returns 2. Confirmed.

**Done when:** README documents the skill and the convention. Met.

---

## Self-Review

| Check | Result |
|-------|--------|
| **Spec coverage** | "Bring what internal-ring has about the standard and usage of worktrees" -> Epic 1.1 merges both ring sources (standard + usage). "Create for Rigor" -> Epic 1.1 adapts to Rigor (config-aware dirs, Gate-0 baseline test, rigor:* integration). "Live in code domain pack" + chosen "domain-scoped invokable skill" -> skill at `skills/domain/software/skills/worktree/`, installed as a slash command only when domain active (Epic 1.2). Auto-loading (agent Skill-tool discovery) -> `install.mjs` symlink (Epic 1.3). Multi-agent collision safety -> Concurrency section in Epic 1.1 (unique path+branch, one-agent-per-worktree, `git worktree list` pre-check, reconverge ordering). |
| **Vagueness scan** | Phase 1 tasks name exact files, functions (`discoverDomainScopedSkills`, `handleInstallCommands`, `loadConfig`, `parseSkillFrontmatter`), line ranges, and the four discovery test cases. No "appropriate"/"TBD". |
| **Contract consistency** | On-disk path `skills/domain/<domain>/skills/<name>/SKILL.md`, slash-command name `rigor:<leaf>` / file `rigor-<leaf>.md`, and de-dup-by-`shortName`-top-level-wins are stated once and referenced by 1.1, 1.2, and 2.1. `SkillMeta` shape reused, not redefined. |
| **Phase boundaries** | Phase 1 ends with a fully usable skill on both surfaces -- a domain-gated `/rigor:worktree` slash command and an auto-discoverable Skill -- with concurrency rules baked in. Phase 2 adds docs + the dogfood `.gitignore` fix, independently verifiable. |
| **Verification plausibility** | Commands target real paths; `npm run build` (tsc) and `npm test` (vitest run) exist in `package.json:12-17`; no lint script is configured, so verification does not reference one. |

---

**Open decision surfaced for execution (not a blocker):** whether domain-scoped skills should be named by bare leaf (`rigor:worktree`) or namespaced (`rigor:software-worktree`) to avoid cross-domain collisions. Phase 1 assumes bare leaf (matches the approved preview) with top-level precedence on collision; revisit only if a second domain ships a same-named skill.
