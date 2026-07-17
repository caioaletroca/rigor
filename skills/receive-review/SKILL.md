---
name: rigor:receive-review
description: >-
  Process code review feedback with technical verification — read, verify,
  evaluate, then implement one at a time. Prevents performative agreement
  and blind implementation.
---

Process code review feedback through a strict six-step verification pipeline: read all feedback, restate for understanding, verify against the codebase, evaluate technical merit, respond with reasoning, and implement one change at a time. Never agree blindly. Never batch fixes.

**Core principle:** Verify, don't blindly agree. Every suggestion gets checked against codebase reality before implementation.

**Announce at start:** "Using rigor:receive-review to process review feedback."

---

## HARD STOP -- READ ALL FEEDBACK FIRST

Before doing anything else, read every piece of review feedback completely. No partial reads, no reacting to the first comment, no jumping to implementation.

If feedback arrives as PR comments, inline annotations, or a verbal list: collect ALL items before proceeding to Step 1. Do NOT start processing until you have the full picture.

---

## Step 1 -- Read

Read ALL feedback in its entirety. Collect every comment, suggestion, and concern into a single list.

- Number each item sequentially for tracking
- Note the reviewer source for each item (PR comment, inline annotation, verbal, AI reviewer, etc.)
- Do NOT form opinions yet
- Do NOT start implementing anything

Output a numbered list of all feedback items before proceeding.

---

## Step 2 -- Understand

Restate each piece of feedback in your own words. This forces genuine comprehension and surfaces ambiguity.

For each item:
1. Restate what the reviewer is asking for
2. Identify the reviewer's underlying concern (what problem are they trying to solve?)
3. Flag anything unclear

**HARD STOP on unclear items:** If ANY item is unclear, STOP. Ask the reviewer for clarification before proceeding. Do NOT guess at intent. Do NOT implement unclear suggestions "to be safe."

---

## Step 3 -- Verify

Check every suggestion against codebase reality. This is the step that prevents blind agreement.

For each item, run concrete verification:

```bash
# Does the pattern the reviewer suggests actually exist elsewhere?
grep -r "<pattern>" .

# Does the file/function the reviewer references exist as described?
# Read the actual code, don't rely on the reviewer's description

# Check git history for context on why the current implementation exists
git log --oneline -10 -- <file>
git log --all --oneline --grep="<relevant term>"
```

For each item, answer:
- Does the suggestion actually apply to THIS codebase?
- Is the reviewer's assumption about the current code correct?
- Does the current implementation have a reason the reviewer may not know about?
- Would the suggestion break existing functionality?

Record your verification findings for each item.

---

## Step 4 -- Evaluate

With verification data in hand, evaluate each suggestion on its technical merits.

### Evaluation Criteria

| Question | If YES | If NO |
|----------|--------|-------|
| Is the suggestion technically correct for this codebase? | Proceed to accept | Push back with evidence |
| Does it break existing functionality? | Push back with evidence | Proceed to accept |
| Does the pattern exist elsewhere in the codebase? | Consistent — lean accept | YAGNI check — question adding it |
| Is there a documented reason for the current approach? | Push back citing the reason | Proceed to evaluate on merit |
| Does it conflict with existing architectural patterns? | Push back with evidence | Proceed to accept |

### YAGNI Check

When a reviewer suggests adding "professional" features (logging frameworks, metrics, error handling abstractions, configuration layers, abstraction interfaces), grep the codebase first:

```bash
# Does this pattern exist ANYWHERE in the codebase?
grep -r "<suggested pattern>" .
```

If the pattern does not exist elsewhere in the codebase, question adding it. A single instance of a pattern is not a pattern — it is an anomaly. Do NOT add infrastructure the codebase does not use just because a reviewer thinks it is "best practice."

### External Reviewer Skepticism

Be especially skeptical of suggestions from external reviewers or AI-generated reviews. Verify that:

1. The suggestion is technically correct for THIS codebase (not just generally correct)
2. It does not break existing functionality
3. The current implementation does not have good reasons the reviewer lacks context for
4. It works on all platforms and versions the project supports

External reviewers have not lived in this codebase. They pattern-match from other projects. Their suggestions may be correct in general but wrong here.

---

## Step 5 -- Respond

Communicate your evaluation for each item. No empty agreement. No performative praise.

### For correct suggestions:
- Acknowledge what is correct and why
- State what you will change

### For incorrect suggestions:
- State the technical reason the suggestion does not apply
- Cite the codebase evidence (file, line, grep result, git history)
- Propose an alternative if one exists

### For partially correct suggestions:
- Acknowledge the valid part
- Explain what does not apply and why
- State what you will implement and what you will skip

### Forbidden Phrases

Do NOT use any of these performative agreement phrases:

| Phrase | Why It Is Forbidden |
|--------|---------------------|
| "You're absolutely right!" | Empty agreement — indicates no verification happened |
| "Great point!" | Performative — tells the reviewer nothing |
| "Excellent suggestion!" | Flattery is not a technical response |
| "Good catch!" | May be genuine but is overused as filler |
| "I completely agree!" | Agreement without reasoning is worthless |
| "That's a really good idea!" | Evaluation, not praise, is the job |

Instead, be direct: "This applies — the current code does X, the suggestion fixes Y because Z" or "This does not apply — the current code does X for reason Y, verified by Z."

---

## Step 6 -- Implement

Implement accepted suggestions ONE AT A TIME. Never batch.

### Implementation Order

1. **Blocking issues** — anything that prevents the code from compiling or running
2. **Simple fixes** — naming, formatting, single-line changes
3. **Complex fixes** — logic changes, refactors, structural modifications

### Per-Suggestion Cycle

For each accepted suggestion:

1. Make the change
2. Run the relevant test suite or verification command
3. Confirm the change works and does not break anything
4. Move to the next suggestion

**HARD STOP on test failure:** If a change breaks a test, STOP. Do NOT continue to the next suggestion. Fix or revert the current change first.

### Never Batch

Do NOT combine multiple suggestions into a single change. Each suggestion is its own atomic unit. If suggestion 3 breaks something, you need to know it was suggestion 3, not "somewhere in suggestions 2-5."

---

## When to Push Back

Push back with technical reasoning when a suggestion:

| Situation | Response |
|-----------|----------|
| Breaks existing functionality | "This breaks X — verified by running Y" |
| Lacks full codebase context | "The current approach exists because X — see git log / comment at file:line" |
| Violates YAGNI | "This pattern does not exist elsewhere in the codebase — adding a single instance creates inconsistency" |
| Is technically incorrect | "This does not work because X — verified by Y" |
| Has legacy or architectural reasons | "This was implemented this way because X — see commit abc123 / ADR / design doc" |
| Conflicts with existing patterns | "The codebase uses pattern X everywhere — this suggestion introduces pattern Y in one place" |
| Is platform-specific and breaks portability | "This works on X but breaks on Y — verified by Z" |

Pushing back is not confrontational. It is professional. A reviewer who made an incorrect suggestion wants to know — they do not want you to silently implement something that hurts the codebase.

---

## Anti-Patterns (FORBIDDEN)

- Do NOT implement suggestions without verifying them against the codebase first — verification is not optional, it is Step 3
- Do NOT use performative agreement phrases — they signal that no verification happened
- Do NOT batch multiple suggestions into a single change — one at a time, test each
- Do NOT implement unclear suggestions — ask for clarification first
- Do NOT skip the YAGNI check when a reviewer suggests adding patterns that do not exist in the codebase
- Do NOT assume external or AI reviewers have full codebase context — they almost never do
- Do NOT continue implementing after a test failure — fix or revert the current change first
- Do NOT treat reviewer seniority as a substitute for technical verification — verify regardless of who made the suggestion
- Do NOT implement all suggestions "to be thorough" — evaluate each on its own merit

---

## Anti-Rationalization Table

| Rationalization | Why It Is WRONG | Required Action |
|-----------------|-----------------|-----------------|
| "The reviewer is senior, they must be right" | Seniority does not mean they have read this codebase. They may be pattern-matching from a different project. | **MUST verify against codebase reality regardless of reviewer seniority** |
| "I will implement all suggestions to be thorough" | Thoroughness means evaluating each suggestion, not blindly accepting all of them. Implementing a wrong suggestion is not thorough — it is negligent. | **MUST evaluate each suggestion individually on technical merit** |
| "This seems like a good idea" | Where is the verification? Did you grep? Did you check git history? "Seems like" is not evidence. | **MUST provide concrete codebase evidence before accepting** |
| "I will batch these fixes together to save time" | If one fix breaks something, you cannot isolate which one. Batching trades debuggability for speed and always loses. | **MUST implement one suggestion at a time and test after each** |
| "The reviewer said 'should' so it is optional" | "Should" still requires verification and a response. Optional does not mean ignore. | **MUST verify, evaluate, and respond even to soft suggestions** |
| "I will just agree to avoid conflict" | Agreeing with an incorrect suggestion damages the codebase. The reviewer wants correctness, not compliance. | **MUST push back with technical evidence when a suggestion is wrong** |
| "The suggestion matches best practices" | Best practices are general. This codebase is specific. A best practice that conflicts with existing patterns creates inconsistency worse than the original issue. | **MUST check whether the practice exists in this codebase before adding it** |
| "I will implement it and revert if it breaks" | You should know if it will break BEFORE implementing. That is what Step 3 (Verify) is for. | **MUST complete verification before implementation** |
