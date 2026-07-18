# Scaffold Commands: new-domain and new-lang-pack

> **For implementers:** This is a rolling-wave plan. Phase 1 tasks are
> dispatch-ready. Later phases are epic-level only -- elaborate them against
> the real codebase when execution reaches them.
> This document is the living source of truth -- task elaboration for later
> phases is written back into it during execution.

**Goal:** Add two MCP tools (`new_domain` and `new_lang_pack`) that scaffold
new domain packs and lang packs from validated templates, so users can extend
Rigor's gate system without manually copying file structures.

**Architecture:** Each tool collects parameters (name, optional fields),
validates them against naming conventions and conflict checks, then writes
the scaffolded files to `skills/domain/<name>/` or `skills/lang/<name>/`.
The scaffolding logic lives in `src/scaffold/` — one module per entity type.
Both tools follow the existing MCP tool registration pattern
(`server.tool(name, schema, handler)` returning `CallToolResult`). The
generated files follow the exact structure of existing packs: `DOMAIN.md` +
`defaults.yaml` for domain packs, `SKILL.md` + `defaults.yaml` for lang packs.

**Tech Stack:** TypeScript, MCP SDK (`@modelcontextprotocol/sdk`), YAML
serialization (`yaml` package already in deps), `fs/promises` for file writes.

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | `new_lang_pack` tool scaffolds a working lang pack with variables, SKILL.md, and defaults.yaml — registered in DOMAIN.md | 1.1, 1.2 | Done |
| 2 | `new_domain` tool scaffolds a working domain pack with DOMAIN.md, defaults.yaml, and check definitions | 2.1, 2.2 | Done |
| 3 | Init skill auto-discovers custom packs; scaffold validation enhanced | 3.1 | Done |

---

## Phase 1: new_lang_pack Tool

At the end of this phase, `new_lang_pack` creates a fully functional lang
pack directory under `skills/lang/<name>/` with a `defaults.yaml` containing
the required `${lang.*}` variables and a `SKILL.md` documenting detection
heuristics, gate commands, and review patterns. The tool validates the name,
prevents overwriting existing packs, and registers the new pack in the
software domain pack's `DOMAIN.md` table.

---

### Epic 1.1: Lang Pack Scaffolding Engine

**Goal:** A `scaffoldLangPack()` function exists that generates `defaults.yaml`
and `SKILL.md` for a new lang pack, writing them to
`skills/lang/<name>/`.
**Scope:** `src/scaffold/` (new directory)
**Dependencies:** none
**Done when:** Calling `scaffoldLangPack({ name: "rust", test_command: "cargo test", lint_command: "cargo clippy", coverage_pattern: "auto" })` creates `skills/lang/rust/defaults.yaml` and `skills/lang/rust/SKILL.md` with correct structure. Overwrite of existing pack (`go`, `react`, etc.) is rejected with an error.
**Status:** Done

#### Task 1.1.1: Create lang pack scaffold function

- [x] Done

**Context:** Existing lang packs follow a consistent pattern. The React lang pack at `skills/lang/react/defaults.yaml:1-14` shows the variable structure:

```yaml
variables:
  lang.test_command: "npx vitest run --coverage"
  lang.lint_command: "npx eslint ."
  lang.coverage_pattern: "auto"
```

Backend lang packs (Go, TypeScript, Python, C#) define only the three core variables (`test_command`, `lint_command`, `coverage_pattern`). Frontend packs (React) additionally define `a11y_command`, `visual_command`, `e2e_command`, `perf_command`. The `SKILL.md` files are comprehensive but follow a standard template with sections: Detection Heuristics, Gate 0 Commands, Gate 8 Review Tools, Gate 8 Patterns, Dependencies.

The software domain pack's `defaults.yaml` at `skills/domain/software/defaults.yaml:1-23` references these variables as `${lang.*}` placeholders in its `checks[]` array.

**Implementation vision:** Create `src/scaffold/lang-pack.ts` with:

- `LangPackInput` interface: `{ name: string; test_command: string; lint_command: string; coverage_pattern?: string; frontend?: boolean }`. When `frontend` is true, also accept `a11y_command`, `visual_command`, `e2e_command`, `perf_command` (all optional, default to empty).
- `scaffoldLangPack(input: LangPackInput, projectRoot: string): Promise<ScaffoldResult>`:
  1. Validate `name`: lowercase alphanumeric + hyphens, no spaces, 2-30 chars. Reject reserved names that match existing packs (`go`, `ts`, `react`, `py`, `csharp`).
  2. Check `skills/lang/<name>/` doesn't already exist. If it does, return an error result (don't throw — match the MCP tool error pattern).
  3. Create `skills/lang/<name>/` directory.
  4. Write `defaults.yaml` with a `variables:` section containing the three core `lang.*` entries. If `frontend: true`, include the four additional frontend variables.
  5. Write `SKILL.md` from a template that includes: pack name, detection heuristics (left as TODOs for the user to fill), Gate 0 commands table, and a skeleton Gate 8 patterns section.
  6. Return `ScaffoldResult` with the list of created files and the pack name.

- `ScaffoldResult` type: `{ success: boolean; files_created: string[]; error?: string }`.

For the `defaults.yaml`, use string concatenation or a template literal — not the `yaml` library — since the output is simple and we want exact control over comments and formatting.

For `SKILL.md`, use a template literal with the pack name and commands interpolated. Keep the template minimal — it's a starting point, not a finished artifact.

**Files:**
- Create: `src/scaffold/lang-pack.ts`
- Create: `src/scaffold/index.ts` (barrel export)
- Test: `src/scaffold/__tests__/lang-pack.test.ts`

**Verification:** `npm test -- --run src/scaffold/__tests__/lang-pack.test.ts` passes. Tests:
1. Scaffolds a backend lang pack — creates both files with correct content
2. Scaffolds a frontend lang pack — includes additional variables
3. Rejects existing pack name — returns error
4. Rejects invalid name (spaces, uppercase) — returns error
5. Generated `defaults.yaml` is valid YAML with correct variable keys

**Done when:** `scaffoldLangPack()` produces correct files for both backend and frontend lang packs, validates inputs, and prevents overwrites.

---

#### Task 1.1.2: Update DOMAIN.md with new lang pack entry

- [x] Done

**Context:** The software domain pack's `DOMAIN.md` at `skills/domain/software/DOMAIN.md:28-34` has an "Available Lang Packs" table listing all lang packs with their variables. When a new lang pack is scaffolded, it should be added to this table.

**Implementation vision:** Add a `registerLangPackInDomain(packName: string, variables: string[], domainMdPath: string): Promise<void>` function to `src/scaffold/lang-pack.ts`. This function:

1. Reads `DOMAIN.md` content.
2. Finds the "Available Lang Packs" table (search for `| Language | Pack |`).
3. Appends a new row before the last empty line after the table: `| <Name> | rigor:lang:<name> | <variables joined by ", "> |`.
4. Writes the updated file.

Call this from `scaffoldLangPack()` after writing the pack files. The domain pack path is `skills/domain/software/DOMAIN.md` relative to project root — this is the only domain pack that tracks lang packs today.

If `DOMAIN.md` doesn't exist or doesn't have the table, skip registration silently (the pack is still usable without the table entry).

**Files:**
- Modify: `src/scaffold/lang-pack.ts` (add `registerLangPackInDomain`)
- Test: `src/scaffold/__tests__/lang-pack.test.ts` (add table update test)

**Verification:** Test creates a mock `DOMAIN.md` with the table, scaffolds a pack, asserts the new row appears. `npm test -- --run src/scaffold/__tests__/lang-pack.test.ts` passes.

**Done when:** New lang packs are automatically listed in `DOMAIN.md`.

---

### Epic 1.2: new_lang_pack MCP Tool

**Goal:** A `new_lang_pack` MCP tool is registered that accepts parameters
and calls the scaffolding engine, returning a formatted result to the agent.
**Scope:** `src/tools/`, `src/server.ts`
**Dependencies:** Epic 1.1
**Done when:** Calling `new_lang_pack` with `{ name: "rust", test_command: "cargo test", lint_command: "cargo clippy" }` scaffolds the pack and returns a success message listing created files. Invalid input returns a clear error.
**Status:** Done

#### Task 1.2.1: Register new_lang_pack MCP tool

- [x] Done

**Context:** Tool registration follows the pattern in `src/tools/cycle.ts:202` — export a `registerScaffoldTools(server: McpServer)` function that calls `server.tool()`. Each tool takes a Zod schema for input validation and returns `CallToolResult`. The server wires tools in `src/server.ts:40-55` via `createServer()`.

**Implementation vision:** Create `src/tools/scaffold.ts` with:

- `registerScaffoldTools(server: McpServer, projectRoot: string)`:
  - Registers `new_lang_pack` tool with Zod schema:
    - `name: z.string()` (required)
    - `test_command: z.string()` (required)
    - `lint_command: z.string()` (required)
    - `coverage_pattern: z.string().optional()` (defaults to `"auto"`)
    - `frontend: z.boolean().optional()` (defaults to `false`)
    - Frontend-specific optional fields when `frontend: true`
  - Handler calls `scaffoldLangPack(input, projectRoot)` and formats the result
  - Success: lists created files, suggests next steps ("edit SKILL.md to add detection heuristics and review patterns")
  - Error: returns `isError: true` with the error message

Wire `registerScaffoldTools` in `src/server.ts` inside `createServer()`, passing `projectRoot`.

Export from `src/tools/index.ts`.

**Files:**
- Create: `src/tools/scaffold.ts`
- Modify: `src/server.ts` (call `registerScaffoldTools` in `createServer()`)
- Modify: `src/tools/index.ts` (export `registerScaffoldTools`)
- Test: `src/tools/__tests__/scaffold.test.ts`

**Verification:** `npm test -- --run src/tools/__tests__/scaffold.test.ts` passes. Tests:
1. Tool returns success with file list for valid input
2. Tool returns error for duplicate pack name
3. Tool returns error for invalid name format
4. Full round-trip: tool creates files, files are readable and valid

**Done when:** `new_lang_pack` MCP tool works end-to-end. `npm test` passes.

---

#### Task 1.2.2: Update config.example.yaml with scaffold documentation

- [x] Done

**Context:** `skills/config.example.yaml` at line 1-233 is the annotated reference. It doesn't currently document the scaffold tools. Since the tools don't require configuration (they're MCP tools, not config-driven), this task adds a comment block noting the available scaffold tools for discoverability.

**Implementation vision:** Add a short commented section at the end of `skills/config.example.yaml`:

```yaml
# ─── Scaffold Tools ───────────────────────────────────────────────
# These MCP tools help create new domain packs and lang packs:
#
#   new_lang_pack: Create a new language pack
#     name: "rust"
#     test_command: "cargo test"
#     lint_command: "cargo clippy"
#     coverage_pattern: "auto"   # optional
#     frontend: false             # optional, adds a11y/visual/e2e/perf vars
#
#   new_domain: Create a new domain pack (coming soon)
#     name: "data-science"
#     description: "Data science and ML projects"
```

**Files:**
- Modify: `skills/config.example.yaml`

**Verification:** YAML parses without errors (comments are valid YAML).

**Done when:** Users can discover scaffold tools via the example config.

---

## Phase 2: new_domain Tool

At the end of this phase, `new_domain` creates a domain pack under
`skills/domain/<name>/` with a `DOMAIN.md` (documenting detection signals,
what the domain provides, and a lang pack compatibility table) and a
`defaults.yaml` (with user-defined check definitions using `${lang.*}`
placeholders). The tool validates naming, prevents overwrites, and produces
a pack that the config loader can discover and merge.

---

### Epic 2.1: Domain Pack Scaffolding Engine

**Goal:** A `scaffoldDomainPack()` function generates `DOMAIN.md` and
`defaults.yaml` for a new domain pack. The generated `defaults.yaml` follows
the same `gates.gate_0.checks[]` structure as the software domain pack.
**Scope:** `src/scaffold/`
**Dependencies:** Phase 1 patterns (scaffold result type, validation, file writing)
**Done when:** `scaffoldDomainPack({ name: "data-science", checks: [...] })` creates
both files. Config loader at `src/config/loader.ts:127-147` can load the
generated `defaults.yaml` via `loadDomainPackDefaults()`. Overwrite prevented.
**Status:** Done

#### Task 2.1.1: Create domain pack scaffold function

- [x] Done

**Files:**
- Created: `src/scaffold/domain-pack.ts`
- Updated: `src/scaffold/index.ts` (barrel export)
- Test: `src/scaffold/__tests__/domain-pack.test.ts` (9 tests)

---

### Epic 2.2: new_domain MCP Tool

**Goal:** `new_domain` MCP tool is registered alongside `new_lang_pack`,
accepting domain name, description, detection signals, and check definitions.
**Scope:** `src/tools/scaffold.ts`, `src/server.ts`
**Dependencies:** Epic 2.1
**Done when:** Tool creates a working domain pack discoverable by the config
loader. Clear error on invalid input or name collision.
**Status:** Done

#### Task 2.2.1: Register new_domain MCP tool

- [x] Done

**Files:**
- Modified: `src/tools/scaffold.ts` (added `handleNewDomain` and `new_domain` tool registration)
- Modified: `src/tools/index.ts` (exported `handleNewDomain`, `NewDomainParams`)
- Test: `src/tools/__tests__/scaffold.test.ts` (added 5 domain tool tests)

---

## Phase 3: Discovery and Validation

At the end of this phase, the init skill auto-discovers custom domain packs
and lang packs (not just the built-in ones). Scaffold validation is enhanced
to check that generated variables match domain pack expectations.

---

### Epic 3.1: Init Skill Custom Pack Discovery

**Goal:** `rigor:init` discovers lang packs and domain packs beyond the
hardcoded set, so scaffolded packs are immediately usable without editing
the init skill. The scaffold tools validate that generated lang pack variables
cover what the target domain pack's `defaults.yaml` references.
**Scope:** `skills/init/SKILL.md`, `src/scaffold/`
**Dependencies:** Phase 2
**Done when:** A user who scaffolds `lang/rust` and runs `rigor:init` on a Rust
project sees the pack detected and applied. A scaffolded lang pack that
misses a variable the domain pack needs gets a warning at scaffold time.
**Status:** Done

#### Task 3.1.1: Create discovery and validation module

- [x] Done

**Files:**
- Created: `src/scaffold/discovery.ts` (`discoverLangPacks`, `discoverDomainPacks`, `validateLangPackVariables`)
- Updated: `src/scaffold/index.ts` (barrel export)
- Test: `src/scaffold/__tests__/discovery.test.ts` (10 tests)

#### Task 3.1.2: Integrate validation into scaffold tools

- [x] Done

**Files:**
- Modified: `src/tools/scaffold.ts` (added variable validation warning to `handleNewLangPack`)

#### Task 3.1.3: Update init skill for custom pack discovery

- [x] Done

**Files:**
- Modified: `skills/init/SKILL.md` (added Custom Domain Packs and Custom Lang Packs sections to Step 0)
