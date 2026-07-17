---
name: rigor:brainstorm
description: >-
  Socratic design exploration -- transforms rough ideas into validated designs
  through structured questioning, alternative exploration, and explicit approval
  gates. Six strict phases: autonomous recon, understanding, exploration, design
  presentation, documentation, and planning handoff. Use when the user has an
  idea or problem that needs design work before planning. Skip when a design
  already exists and the user just needs a plan (use rigor:plan instead).
---

Transform a rough idea into a validated, documented design through a 6-phase Socratic process. Every phase must complete before the next begins. The process is evidence-driven: research the codebase before forming opinions, explore alternatives before committing, and require explicit human approval before documenting.

**Announce at start:** "Using rigor:brainstorm to explore this design."

---

## HARD STOP -- PHASE DISCIPLINE

Phases are strictly linear. You CANNOT skip ahead, merge phases, or work on two phases simultaneously.

| Phase | Name | Gate to exit |
|-------|------|-------------|
| 1 | Prep (Autonomous Recon) | Findings pasted into session |
| 2 | Understanding | User confirms restated understanding |
| 3 | Exploration | User selects an approach |
| 4 | Design Presentation | User gives explicit approval |
| 5 | Design Documentation | Document saved to disk |
| 6 | Planning Handoff | Hand off to `rigor:plan` |

You must announce the current phase before starting it:

```
--- Phase N: [Name] ---
```

---

## Phase 1 -- Prep (Autonomous Recon)

**Purpose:** Collect hard evidence about the project before forming any mental model. This prevents building designs on assumptions.

**This phase is MANDATORY.** Do not ask the user what the project looks like. Find out yourself.

### What to collect

Run these commands and read these files. Paste a summary of findings before continuing.

```bash
# Project structure (top 2 levels)
find . -maxdepth 2 -type f -name "*.go" -o -name "*.ts" -o -name "*.js" -o -name "*.cs" -o -name "*.py" -o -name "*.rs" | head -60

# Recent git history (last 20 commits)
git log --oneline -20

# Dependencies and project metadata
# (check for go.mod, package.json, *.csproj, Cargo.toml, requirements.txt, pyproject.toml)

# Test count
# (count test files matching *_test.go, *.test.ts, *.spec.ts, *Tests.cs, test_*.py, *_test.rs)

# README or docs
# (read README.md if it exists, first 80 lines)

# Existing architecture artifacts
# (check for docs/plans/, docs/architecture/, .rigor/, openapi.yaml, schema.sql)
```

Adapt to whatever the project actually uses. The list above is a starting point, not a checklist to follow blindly for a Rust project that has no `package.json`.

### What to produce

A **Recon Summary** block pasted into the session:

```
Recon Summary
-------------
Language(s):    [detected]
Framework(s):   [detected or "none"]
Package manager: [detected]
Entry points:   [main files or commands]
Test count:     [N test files]
Architecture:   [monolith / service / library / CLI / monorepo]
Key directories: [list with one-line purpose each]
Recent activity: [what the last 10 commits touched]
Existing docs:  [what exists in docs/]
Relevant prior art: [existing code/patterns related to the user's idea]
```

After pasting the summary, proceed to Phase 2. Do NOT ask the user to confirm the recon -- it is factual, not interpretive.

---

## Phase 2 -- Understanding

**Purpose:** Build a mental model from recon + the user's idea. Ask clarifying questions. Restate understanding for confirmation.

### Question budget: 3 maximum

You get at most 3 questions in this phase. If you need more information, research the codebase instead of asking. Every question you ask must prove you already looked:

**Bad:** "What database do you use?"
**Good:** "I see `pgxpool` in `go.mod` and connection setup in `internal/db/conn.go`. Are you planning to reuse that pool or stand up a separate one for this feature?"

### What to produce

After the user answers (or if no questions are needed), restate your understanding:

```
My understanding
----------------
[2-4 sentences describing what the user wants to build/change, grounded in
recon findings and their input. Include scope boundaries -- what is IN and
what is OUT.]
```

Then ask: **"Is this accurate, or should I adjust anything?"**

Wait for confirmation before proceeding. If the user corrects you, update the understanding and confirm again.

---

## Phase 3 -- Exploration

**Purpose:** Generate 2-3 alternative approaches. Present structured choices with tradeoffs. Do NOT recommend one.

### Rules

- **Always 2-3 alternatives.** Never present just one approach, even if one seems obviously correct.
- **YAGNI ruthlessly.** If an alternative adds complexity without clear, immediate need, call it out in the cons. Kill gold-plating.
- **Do NOT recommend.** Present tradeoffs and let the user decide. Your job is to make the tradeoffs visible, not to choose.

### What to produce

For each alternative:

```
### Option N: [Name]

**Approach:** [2-3 sentences describing the approach]

**Pros:**
- [concrete benefit, grounded in the codebase]
- [...]

**Cons:**
- [concrete cost or risk]
- [...]

**Risks:**
- [what could go wrong; what unknowns remain]

**Effort:** [relative: small / medium / large]
```

After presenting all options, ask: **"Which approach do you want to go with, or should I explore a different direction?"**

Wait for the user to select. If they ask for more options or a hybrid, generate those and present again. Do NOT proceed until the user selects.

---

## Phase 4 -- Design Presentation

**Purpose:** Present the chosen approach as a concrete design. Wait for explicit approval.

### What to produce

A structured design based on the selected option, grounded in the codebase:

```
Design: [Feature/Change Name]
==============================

## Architecture

[How this fits into the existing system. Reference existing files/patterns
discovered in recon.]

## Components

[What new components, modules, or files are needed. What existing ones change.]

| Component | Type | Purpose |
|-----------|------|---------|
| ... | new / modify | ... |

## Data Flow

[How data moves through the system for the key operations this design enables.
Use a step-by-step sequence, not a diagram.]

1. [Actor] sends [what] to [where]
2. [Component] processes [what] by [how]
3. ...

## Key Decisions

[Decisions embedded in this design. Each one is a fork where the other path
was deliberately not taken.]

| Decision | Chosen | Rejected Alternative | Why |
|----------|--------|---------------------|-----|
| ... | ... | ... | ... |

## Open Questions

[Anything that cannot be resolved without implementation experience.
These become learning goals for Phase 1 of the plan.]
```

### Approval gate

After presenting the design, ask: **"Does this design look right? Say 'approved' to proceed to documentation, or tell me what to change."**

**HARD STOP:** The design is NOT approved until the user says one of these words (case-insensitive):
- "approved"
- "looks good"
- "proceed"
- "let's implement"
- "yes"
- "go ahead"
- "ship it"
- "lgtm"

The following do NOT count as approval:
- "interesting"
- "cool"
- "ok" (ambiguous -- could mean "ok, I see it" not "ok, proceed")
- "hmm"
- silence / no response
- any response that includes a question or change request

If the user requests changes, revise the design and present again. Repeat until explicit approval.

---

## Phase 5 -- Design Documentation

**Purpose:** Write the approved design as a structured document. Only runs after Phase 4 approval.

### Save path

`docs/designs/YYYY-MM-DD-<feature-name>.md`

User preferences override the default path. If the `docs/designs/` directory does not exist, create it.

### Document format

```markdown
# [Feature/Change Name] -- Design Document

> **Status:** Approved
> **Date:** YYYY-MM-DD
> **Exploration:** [count] alternatives evaluated

## Context

[Why this design exists. What problem it solves. 2-3 sentences.]

## Architecture

[From Phase 4, refined.]

## Components

[From Phase 4, refined.]

## Data Flow

[From Phase 4, refined.]

## Key Decisions

[From Phase 4, refined into a decision log.]

## Open Questions

[From Phase 4. These feed into the plan as Phase 1 learning goals.]

## Alternatives Considered

[Brief summary of each rejected alternative from Phase 3 and why it was
rejected. This prevents future re-exploration of already-evaluated paths.]
```

After saving, announce: **"Design document saved to `<path>`."**

---

## Phase 6 -- Planning Handoff

**Purpose:** Hand off the approved design to `rigor:plan` for implementation planning.

After the document is saved, ask:

> Design is documented. Ready to plan the implementation?
>
> **1. Plan now** -- hand off to `rigor:plan` in this session
>
> **2. Plan later** -- design is saved; plan in a separate session
>
> **3. Skip planning** -- design only, no plan needed

If the user chooses option 1 and `rigor:plan` is available, hand off to it with the design document path as context. The plan skill reads the design document as its input spec.

---

## Anti-Patterns (FORBIDDEN)

- Do NOT skip recon -- every brainstorm starts with evidence collection, even if you think you know the codebase
- Do NOT ask more than 3 questions per phase -- research the codebase instead
- Do NOT present a single approach without alternatives -- always 2-3 options with tradeoffs
- Do NOT recommend an approach during exploration -- present tradeoffs and let the user decide
- Do NOT treat ambiguous responses as design approval -- require explicit approval words
- Do NOT write the design document before getting explicit approval -- Phase 5 is gated on Phase 4
- Do NOT skip phases or combine phases -- each phase has a distinct purpose and exit gate
- Do NOT form opinions before completing recon -- assumptions compound into wrong designs
- Do NOT add complexity without clear need -- apply YAGNI to every alternative
- Do NOT ask questions that the codebase can answer -- prove you looked before asking

---

## Anti-Rationalization Table

| Rationalization | Why It Is WRONG | Required Action |
|-----------------|-----------------|-----------------|
| "The user seems to want X so I will skip understanding" | Your assumption about what they want may be wrong. Phase 2 exists to verify, not to rubber-stamp your guess. | **MUST complete recon, ask clarifying questions, and get understanding confirmed** |
| "This is simple enough to skip alternatives" | Simple-looking problems often have non-obvious tradeoffs. The user deserves to see options before committing. | **MUST generate 2-3 alternatives with tradeoffs in Phase 3** |
| "They said 'sounds good' so design is approved" | "Sounds good" is not in the explicit approval word list. It could mean "I understand" not "I approve." | **MUST ask for explicit approval using the listed trigger words** |
| "I already know this codebase" | Your knowledge may be stale, incomplete, or wrong. Recon takes 30 seconds and prevents building on false assumptions. | **MUST run recon every time -- no exceptions** |
| "3 questions is not enough to understand this" | If 3 questions are not enough, you have not researched the codebase sufficiently. Read code instead of asking. | **MUST research the codebase instead of exceeding the question budget** |
| "One approach is clearly better so alternatives waste time" | The user may see tradeoffs you do not. Presenting one option removes their agency. | **MUST present 2-3 alternatives regardless of personal preference** |
| "The user said 'ok' so I will proceed to documentation" | "Ok" is ambiguous acknowledgment, not approval. The approval gate exists to prevent premature commitment. | **MUST get an explicit approval word before Phase 5** |
| "I will combine recon and understanding to save time" | Combining phases means forming opinions before evidence collection is complete. Recon is facts; understanding is interpretation. They are separate for a reason. | **MUST complete Phase 1 fully before starting Phase 2** |
| "This idea is too vague to explore alternatives for" | Vague ideas benefit MORE from alternatives, not less. Exploration surfaces constraints the user has not articulated. | **MUST explore alternatives -- vagueness is not an exemption** |
| "I will recommend Option 2 since it is the best fit" | Your recommendation biases the user's choice. Present tradeoffs; let them decide. If they ask for your opinion, you may share it -- but not before. | **MUST NOT recommend unless explicitly asked** |
