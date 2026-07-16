# Naming Conventions

Rules for naming Rigor skills and commands.

---

## Namespace

All skills use the `rigor:` prefix. Language-specific skills use a `rigor:lang:` sub-namespace.

---

## Rules

1. **Short imperative verbs or nouns** -- prefer single words. `commit` not `committing-changes`. `pr` not `opening-pull-requests`. `ship` not `shipping-changes`.

2. **When a single word is ambiguous, use verb-noun** with a hyphen -- `write-plan` not `writingplans` or `writing-plans`. Maximum two words.

3. **No gerunds** (-ing forms). `commit` not `committing`. `review` not `reviewing`.

4. **No redundant suffixes** -- no `-changes`, `-code`, `-results` when the context is obvious.

5. **Language-specific skills** use the `lang:` sub-namespace -- `rigor:lang:go`, `rigor:lang:ts`, `rigor:lang:py`. These contain language-specific configurations: lint commands, test commands, coverage parsing, etc.

6. **Skill directory matches the command name** -- `skills/commit/SKILL.md` for `rigor:commit`. Language skills nest under `skills/lang/<language>/SKILL.md`.

---

## Current Catalog

| Skill | Directory | Purpose | Status |
|-------|-----------|---------|--------|
| `rigor:commit` | `skills/commit/` | Atomic commit grouping with scope enforcement | Done |
| `rigor:new-skill` | `skills/new-skill/` | Scaffold a new Rigor skill with conventions enforcement | Done |
| `rigor:pr` | `skills/pr/` | Open a GitHub PR with template filling and base verification | Done |
| `rigor:ship` | `skills/ship/` | End-to-end: branch, commit, push, PR | Done |
| `rigor:test-skill` | `skills/test-skill/` | Pressure-test a skill with/without scenarios | Done |
| `rigor:review` | `skills/review/` | Dispatch parallel code reviewers | Planned |
| `rigor:plan` | `skills/plan/` | Write implementation plan (rolling-wave phases) | Planned |
| `rigor:cycle` | `skills/cycle/` | Run the dev-cycle (gate orchestration) | Planned |
| `rigor:lang:go` | `skills/lang/go/` | Go-specific lint, test, coverage config | Planned |
| `rigor:lang:ts` | `skills/lang/ts/` | TypeScript-specific lint, test, coverage config | Planned |
| `rigor:lang:py` | `skills/lang/py/` | Python-specific lint, test, coverage config | Planned |
| `rigor:lang:rust` | `skills/lang/rust/` | Rust-specific lint, test, coverage config | Planned |

---

## Contrast with Ring

Ring uses verbose gerund-based names. Rigor uses short imperatives.

| Ring | Rigor | Why |
|------|-------|-----|
| `ring:committing-changes` | `rigor:commit` | Shorter, no gerund, no redundant suffix |
| `ring:shipping-changes` | `rigor:ship` | Same |
| `ring:opening-pull-requests` | `rigor:pr` | Obvious what PR means in context |
| `ring:reviewing-code` | `rigor:review` | `-code` is redundant |
| `ring:writing-plans` | `rigor:plan` | Shorter |
| `ring:running-dev-cycle` | `rigor:cycle` | Single word |
| `ring:backend-go` (hardcoded) | `rigor:lang:go` (modular) | Language as plugin, not embedded |
