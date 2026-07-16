---
name: rigor:new-skill
description: >-
  Scaffold a new Rigor skill: gather requirements, validate the name against
  naming conventions, classify the skill type, generate the SKILL.md with
  appropriate sections and TODO markers, and update the catalog. Use when
  creating a new skill from scratch. Skip when editing an existing skill or
  when the SKILL.md already exists.
---

Scaffold a new Rigor skill from requirements to a ready-to-fill SKILL.md with the correct structure, naming, and catalog entry.

---

## Step 0 -- Gather Requirements

Ask the user two questions:

1. **What does the skill do?** (one sentence)
2. **Suggested name?** (or leave blank -- this skill will propose one)

Do NOT proceed until both answers are clear. If the user gives a vague description, ask a follow-up to narrow the scope.

---

## Step 1 -- Validate Name

Apply the naming conventions from `docs/naming-conventions.md`:

| Rule | Check |
|------|-------|
| Length | 1-2 words max, hyphen-separated if 2 |
| No gerunds | Reject `-ing` forms -- `review` not `reviewing` |
| No redundant suffixes | Reject `-changes`, `-code`, `-results` |
| Imperative verb or noun | `commit`, `plan`, `ship`, `review`, `new-skill` |
| Uniqueness | Scan `skills/` directory -- reject if name already exists |
| Language-specific | If the skill is language-specific, MUST use `lang/` sub-namespace (`rigor:lang:<language>`) |

### If the suggested name violates conventions:

1. State which rule it violates
2. Propose 2-3 alternatives that comply
3. Confirm with the user before proceeding

### Directory path resolution:

| Skill Type | Directory |
|------------|-----------|
| Standard | `skills/<name>/SKILL.md` |
| Language pack | `skills/lang/<language>/SKILL.md` |

---

## Step 2 -- Determine Skill Type

Based on the description, classify into one of four types:

| Type | When to Use | Token Target | Key Sections |
|------|-------------|-------------|--------------|
| **Workflow** | Multi-step process with ordering constraints | < 4,000 words | Steps, anti-patterns, anti-rationalization table |
| **Technique** | A pattern or practice to follow | < 2,000 words | When to use, core pattern, quick reference, common mistakes |
| **Reference** | Docs, API lookup, or cheat sheet | < 500 words | Quick reference table, examples |
| **Config** | Language pack or tool configuration | < 1,000 words | Gate defaults, coverage parsing, examples |

State the chosen type and reasoning to the user. If ambiguous, present the options and confirm.

---

## Step 2.5 -- Baseline Test (Workflow and Technique types only)

For Workflow and Technique skills, the anti-rationalization table should come from **observed failures**, not guesswork. Before scaffolding:

1. **Run the task without the skill** -- ask the agent to perform the task the skill will cover, with no special instructions
2. **Note what goes wrong** -- shortcuts taken, steps skipped, assumptions made, rationalizations offered
3. **Record 2-3 concrete failures** -- these become the seed for the anti-rationalization table in the generated SKILL.md

This step is RECOMMENDED, not mandatory. Skip it for:
- Skills ported from another system (failures already known)
- Skills where the failure modes are obvious from experience
- Urgent scaffolding where the table can be filled later

If skipped, add a TODO in the anti-rationalization table: `TODO: Run rigor:test-skill to discover real failure modes`.

---

## Step 3 -- Scaffold Directory and SKILL.md

### 3.1 -- Create the directory

```bash
mkdir -p skills/<name>/
# or for language packs:
mkdir -p skills/lang/<language>/
```

### 3.2 -- Generate SKILL.md

Use the template for the determined type (see Templates below). Fill in:

- **Frontmatter `name`**: `rigor:<name>` (or `rigor:lang:<language>`)
- **Frontmatter `description`**: start with an action verb describing what the skill does. Include "Use when X. Skip when Y." guidance.
- **Section headers**: appropriate for the type
- **Placeholder content**: use `TODO:` markers for content the user must fill in
- **Anti-patterns section**: include for workflow and technique types
- **Anti-rationalization table**: include for workflow types

### 3.3 -- Verify the file

Read back the generated file and confirm it has:

- [ ] Valid YAML frontmatter with `name` and `description`
- [ ] Description starts with an action verb (not "Use when")
- [ ] One-line summary after the frontmatter
- [ ] All required sections for the type
- [ ] TODO markers for unfilled content
- [ ] No emojis
- [ ] Under the token target for the type

---

## Step 4 -- Update Catalog

Add the new skill to `docs/naming-conventions.md` in the Current Catalog table.

Format:

```
| `rigor:<name>` | `skills/<name>/` | <one-line purpose> | Draft |
```

Status is always `Draft` for new skills. Insert the row in alphabetical order within the table (after existing Done entries, before Planned entries that come later alphabetically).

---

## Step 5 -- Report

Show the user:

```
Skill scaffolded
----------------
File:     skills/<name>/SKILL.md
Name:     rigor:<name>
Type:     <Workflow | Technique | Reference | Config>
Sections: <list of section headers>

Next: fill in the TODO markers to complete the skill.
```

---

## Templates

### Workflow Template

```markdown
---
name: rigor:<name>
description: >-
  TODO: Start with an action verb. Describe what this skill does.
  Use when X. Skip when Y.
---
TODO: One-line summary of what this skill does.
---
## Step 1 -- TODO: First Step Name
TODO: Describe what happens in this step.
---
## Step 2 -- TODO: Second Step Name
TODO: Describe what happens in this step.
---
## Anti-Patterns (FORBIDDEN)
- TODO: List forbidden behaviors
---
## Anti-Rationalization Table
| Rationalization | Why It Is WRONG | Required Action |
|-----------------|-----------------|-----------------|
| TODO | TODO | TODO |
```

### Technique Template

```markdown
---
name: rigor:<name>
description: >-
  TODO: Start with an action verb. Describe what this skill does.
  Use when X. Skip when Y.
---
TODO: One-line summary of what this skill does.
---
## When to Use
TODO: Symptoms and triggers that indicate this technique applies.
## Skip When
TODO: When this skill does not apply.
---
## Core Pattern
TODO: Before/after examples showing the technique.
---
## Quick Reference
| Step | Action |
|------|--------|
| TODO | TODO |
---
## Common Mistakes
- TODO: List common mistakes
```

### Reference Template

```markdown
---
name: rigor:<name>
description: >-
  TODO: Describe what this reference covers.
---
TODO: One-line summary.
---
## Quick Reference
| Item | Description |
|------|-------------|
| TODO | TODO |
---
## Examples
TODO: Concrete examples.
```

### Config (Language Pack) Template

```markdown
---
name: rigor:lang:<language>
description: >-
  TODO: Language-specific configuration for <Language>.
  Provides lint, test, and coverage commands for <Language> projects.
---
<Language>-specific configuration for Rigor gates.
---
## Gate 0 Defaults
| Setting | Value |
|---------|-------|
| `lint_command` | TODO |
| `test_command` | TODO |
| `coverage_command` | TODO |
| `coverage_parser` | TODO |
| `test_file_pattern` | TODO |
---
## Coverage Parsing
TODO: How to parse coverage output for this language.
---
## Examples
TODO: Example .rigor/config.yaml snippet for this language.
```

---

## Anti-Patterns (FORBIDDEN)

- Do NOT create a skill without gathering requirements first -- guessing the purpose leads to rewrites
- Do NOT accept names that violate naming conventions -- fix the name before scaffolding
- Do NOT skip the type classification -- the type determines the template and sections
- Do NOT use a workflow template for a reference skill or vice versa -- each type has its own structure
- Do NOT add content beyond TODO markers -- the user fills in the substance
- Do NOT set status to "Done" in the catalog -- new skills are always "Draft"
- Do NOT scaffold over an existing SKILL.md without confirming with the user
- Do NOT use gerunds in the skill name -- `review` not `reviewing`
- Do NOT start the description with "Use when" -- start with an action verb
- Do NOT add emojis to the generated SKILL.md

---

## Anti-Rationalization Table

| Rationalization | Why It Is WRONG | Required Action |
|-----------------|-----------------|-----------------|
| "The name is close enough to the conventions" | Close is not compliant. A two-word gerund name will look inconsistent next to `commit`, `ship`, `pr`. | **MUST fix the name before scaffolding** |
| "I will fill in the content now to save time" | The skill author needs to write the substance. Pre-filled content gets accepted without review. | **Use TODO markers only** |
| "This skill is simple, it does not need anti-patterns" | Workflow and technique types always need anti-patterns. Simple skills still have misuse modes. | **Include anti-patterns for workflow and technique types** |
| "I will skip the catalog update" | An unregistered skill is invisible to the team. The catalog is the discovery mechanism. | **MUST update docs/naming-conventions.md** |
| "The type is obvious, no need to state it" | Stating the type confirms alignment between the author's intent and the template chosen. | **MUST state type and reasoning to the user** |
| "The name already exists but this version is better" | Overwriting an existing skill without confirmation destroys work. | **MUST confirm with user before overwriting** |
