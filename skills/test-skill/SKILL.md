---
name: rigor:test-skill
description: >-
  Pressure-test a Rigor skill by running scenarios with and without the skill
  loaded, comparing agent behavior, and using observed failures to strengthen
  anti-rationalization tables. Use after writing or editing a workflow or
  technique skill. Skip for reference or config skills.
---

Verify that a skill actually changes agent behavior by testing with and without it, then close any loopholes found.

---

## When to Use

- After creating a new workflow or technique skill
- After editing an existing skill's rules or anti-patterns
- When a skill seems to be ignored or worked around in practice

## Skip When

- Reference skills (no behavioral rules to test)
- Config / language pack skills (declarative, no compliance risk)
- The skill was ported from a tested system and failures are already documented

---

## Step 1 -- Select Scenarios

Choose 2-3 scenarios that exercise the skill's rules. Good scenarios:

| Type | Example |
|------|---------|
| **Happy path** | Task the skill is designed for, straightforward case |
| **Pressure** | Same task but with time pressure or user nudging to skip steps |
| **Edge case** | Unusual input or ambiguous situation where shortcuts are tempting |

Write each scenario as a one-line task prompt. Example for `rigor:commit`:

```
1. "Commit these 5 files that mix a feature, a fix, and a docs change"
2. "Just commit everything quickly, I need to push now"
3. "Commit this, the scope doesn't matter for this repo"
```

---

## Step 2 -- Run WITHOUT the Skill (Baseline)

For each scenario, dispatch a subagent with the task prompt and **no skill loaded**. The subagent should have access to the same repo/context but not the skill being tested.

Record for each scenario:

| Field | What to Capture |
|-------|-----------------|
| **What the agent did** | Exact steps taken |
| **What it skipped** | Steps the skill requires that were omitted |
| **Rationalizations offered** | Any justification for shortcuts ("this is simple enough", "the user said quickly") |
| **Outcome** | What would have gone wrong in practice |

This is the **RED** phase -- you are documenting the failures the skill needs to prevent.

---

## Step 3 -- Run WITH the Skill (Verification)

For the same scenarios, dispatch a subagent with the task prompt and **the skill loaded**. Record:

| Field | What to Capture |
|-------|-----------------|
| **Compliance** | Did the agent follow the skill's steps? |
| **Skipped rules** | Any rules the agent ignored despite the skill |
| **New rationalizations** | Excuses the agent invented to work around the skill |
| **Outcome** | Did the skill produce the correct behavior? |

This is the **GREEN** phase -- the skill should fix the baseline failures.

---

## Step 4 -- Compare and Patch

### 4.1 -- Diff the behavior

For each scenario, compare baseline vs. with-skill:

```
Scenario: "Just commit everything quickly, I need to push now"

WITHOUT skill:
  - Agent committed all files in one commit
  - No scope, no grouping, no plan presented
  - Rationalized: "User wants speed, grouping is unnecessary"

WITH skill:
  - Agent presented commit plan with 3 groups
  - Used scope from allowlist
  - BUT skipped the confirmation step, citing "user urgency"
```

### 4.2 -- Identify loopholes

Any case where the agent still misbehaved WITH the skill is a loophole. Common patterns:

| Pattern | Fix |
|---------|-----|
| Agent skipped a step | Add to anti-patterns: "Do NOT skip Step N even when..." |
| Agent rationalized around a rule | Add to anti-rationalization table with the exact excuse |
| Agent followed the letter but not spirit | Tighten the rule language -- be more specific |
| Agent complied but the output was wrong | The step instructions are ambiguous -- clarify |

### 4.3 -- Patch the skill

For each loophole:
1. Add the observed rationalization to the anti-rationalization table (use the agent's exact words)
2. Add the skipped behavior to anti-patterns
3. Tighten any ambiguous step instructions

---

## Step 5 -- Re-test Patches (Optional)

If significant patches were made, re-run the pressure scenario (scenario 2) with the updated skill to verify the loophole is closed.

This is the **REFACTOR** phase -- iterate until the skill holds under pressure.

One round of patching is usually sufficient. Stop after two rounds -- diminishing returns beyond that.

---

## Step 6 -- Report

Summarize results:

```
Skill tested:  rigor:commit
Scenarios:     3
Baseline failures: 5 (no grouping, no scope, no plan, no confirmation, no signing check)
With skill:    4 fixed, 1 loophole (skipped confirmation under pressure)
Patches:       1 anti-rationalization entry added, 1 anti-pattern added
Status:        PASS -- skill holds under pressure
```

---

## Anti-Patterns (FORBIDDEN)

- Do NOT test with scenarios that do not exercise the skill's rules -- trivial scenarios prove nothing
- Do NOT skip the baseline (WITHOUT skill) run -- without it you cannot tell if the skill actually changed behavior
- Do NOT invent rationalizations for the anti-rationalization table -- use only what the agent actually said
- Do NOT patch the skill without re-reading the current version first -- patches must apply to the actual content
- Do NOT run more than two patch-and-retest cycles -- diminishing returns

---

## Anti-Rationalization Table

| Rationalization | Why It Is WRONG | Required Action |
|-----------------|-----------------|-----------------|
| "The skill is obviously correct, I do not need to test it" | Obvious-looking skills fail under pressure most often because no one tested them | **Run at least the pressure scenario** |
| "The baseline will obviously fail, I can skip it" | The baseline documents HOW it fails -- you need the specific rationalizations for the table | **MUST run baseline to capture failure modes** |
| "One scenario is enough" | One scenario tests one path. Pressure and edge cases reveal different failures. | **MUST run at least 2 scenarios** |
| "I will guess what the agent would say" | Guessed rationalizations miss the real excuses agents use. Real failures are more creative than predictions. | **MUST use observed rationalizations only** |
| "The skill passed all scenarios, no patches needed" | This is the ideal outcome -- report it. But verify the scenarios were actually challenging. | **Verify scenarios included pressure, then report PASS** |
