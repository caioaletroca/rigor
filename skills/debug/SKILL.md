---
name: rigor:debug
description: >-
  Systematic 4-phase debugging -- investigate, trace root cause backward through
  call chain, hypothesize and test, then minimal fix with regression test. No
  shotgun debugging. Combines backward call-chain tracing from error to trigger
  with structured phase gates that prevent fixing before understanding.
---

Systematic 4-phase debugging: reproduce and collect facts, trace backward through the call chain to the root cause, form and test one hypothesis, then write a regression test and apply the minimal fix. Every phase has an exit condition -- you cannot advance until it is met.

**Announce at start:** "Using rigor:debug to systematically debug this issue."

---

## HARD STOP -- NO SHOTGUN DEBUGGING

Before anything else, acknowledge this rule:

You will NOT try random changes hoping one works. You will NOT fix the bug before you understand the root cause. If at any point you catch yourself trying something "just to see if it works," STOP. Go back to Phase 1.

---

## Phase 1 -- Investigate

**Goal:** Reproduce the bug and collect every observable fact. No interpretation yet.

### 1.1 -- Reproduce

Reproduce the bug. Get a reliable set of steps that triggers the error every time.

```
Reproduction steps:
1. [exact input or action]
2. [exact state or precondition]
3. [exact environment: OS, runtime version, config]
Result: [exact error output]
```

If you cannot reproduce:
- Check logs for the original occurrence
- Check if the environment differs (versions, config, data)
- Ask for more information
- DO NOT proceed to Phase 2 until you can trigger the bug

**Exit condition:** You can trigger the bug on demand. If you cannot, you stay in Phase 1.

### 1.2 -- Collect Error Output

Gather everything the system tells you:

- Full stack trace (not truncated)
- Error message (exact text)
- Log output around the time of the error
- Screenshots or UI state if applicable
- Return values, HTTP status codes, exit codes

### 1.3 -- Identify the Crash Site

Find the exact line where the error manifests. This is NOT the root cause -- it is where the symptom appears.

```
Crash site: [file:line]
Error: [exact error message or exception]
```

### 1.4 -- Note Conditions

Document what was true when the bug triggered:

| Condition | Value |
|-----------|-------|
| Input | [what data was provided] |
| State | [relevant application state] |
| Environment | [runtime, OS, config] |
| Frequency | [always, intermittent, first-time-only] |

**Phase 1 output:** Crash site identified, error collected, reproduction confirmed. No hypotheses yet.

---

## Phase 2 -- Root Cause Trace

**Goal:** Trace backward from the crash site through the call chain until you find where the assumption breaks. The root cause is almost never at the crash site.

### 2.1 -- Start at the Crash Site

Begin at the line identified in Phase 1. Ask:

- What function is this in?
- What are its parameters?
- What assumptions does this code make about its inputs?
- Which assumption is violated when the bug triggers?

### 2.2 -- Trace Backward

Move to the caller. At each level, ask:

- Who calls this function?
- What data does it pass?
- Where does that data come from?
- What assumptions does the caller make?

Walk the chain:

```
Error at:    [file:line] -- [what failed]
Called by:    [file:line] -- [what it passed]
Called by:    [file:line] -- [where the data originated]
Root cause:  [file:line] -- [where the assumption breaks]
```

Keep tracing until you find the point where the contract between caller and callee breaks. That is the root cause.

### 2.3 -- Check History

```bash
git log --oneline -20 -- <root-cause-file>
git blame -L <start>,<end> <root-cause-file>
```

- Was this code recently changed?
- What was the intent of the change?
- Did the change introduce the broken assumption?

### 2.4 -- Document the Chain

Write the full trace in one line:

```
Chain: Error [file:line] <- Caller [file:line] <- Caller [file:line] <- Root Cause [file:line]
Broken assumption: [what the code assumes that is not true]
```

**Phase 2 output:** A documented call chain from error to root cause, with the broken assumption identified. If the chain does not reach a clear root cause, you are not done -- keep tracing.

---

## Phase 3 -- Hypothesis & Test

**Goal:** Form one hypothesis based on the root cause trace. Prove or disprove it with a test. Do NOT fix the bug yet.

### 3.1 -- Form ONE Hypothesis

Based on the root cause trace from Phase 2, state a single hypothesis:

```
Hypothesis: [specific, falsifiable statement about what causes the bug]
Example: "The user ID is nil because the auth middleware skips token
validation when the header contains a Bearer prefix with trailing whitespace."
```

One hypothesis at a time. Not two. Not "it might be A or B." Pick the most likely one.

### 3.2 -- Design a Minimal Test

Design the smallest possible test that would confirm or disprove the hypothesis:

```
Test: [what to do]
If hypothesis is correct: [expected result]
If hypothesis is wrong: [expected result]
```

### 3.3 -- Run the Test

Execute the test. Observe the result.

| Result | Action |
|--------|--------|
| Hypothesis confirmed | The root cause is verified. Proceed to Phase 4. |
| Hypothesis disproved | Return to Phase 2 with the new information. The call chain trace was incomplete or the wrong branch was followed. |

**Phase 3 output:** Confirmed root cause with evidence. If not confirmed, loop back to Phase 2. Do NOT proceed to Phase 4 without confirmation.

---

## Phase 4 -- Fix & Verify

**Goal:** Write a regression test, apply the minimal fix, and verify nothing else breaks.

### 4.1 -- Write the Regression Test FIRST

Write a test that captures the bug. This test MUST fail before the fix and pass after.

```
Test name: [descriptive name that explains the bug]
Test input: [the conditions from Phase 1]
Expected (before fix): [the error/wrong behavior]
Expected (after fix): [the correct behavior]
```

Run the test. Confirm it fails. If it passes, your test does not capture the bug -- rewrite it.

### 4.2 -- Implement the Minimal Fix

Fix the root cause identified in Phase 2, confirmed in Phase 3. The fix should:

- Address the broken assumption at the root cause location
- Be as small as possible
- NOT refactor surrounding code
- NOT "improve" nearby code
- NOT "clean up while I'm here"

### 4.3 -- Verify the Fix

```bash
# 1. Run the regression test -- it should pass now
# 2. Run the full test suite -- nothing else should break
# 3. Reproduce the original bug -- it should be gone
```

| Result | Action |
|--------|--------|
| Regression test passes, suite passes, bug gone | Done. |
| Regression test passes, suite fails elsewhere | Your fix has consequences. Trace the new failure (back to Phase 2 for that failure). |
| Regression test still fails | Your fix does not address the root cause. Back to Phase 2. |

### 4.4 -- Summarize

```
Bug: [one-line description]
Root cause: [file:line] -- [broken assumption]
Chain: Error [file:line] <- ... <- Root Cause [file:line]
Fix: [file:line] -- [what was changed]
Regression test: [test file:test name]
Suite status: [all passing / N new failures]
```

**Phase 4 output:** Bug fixed, regression test in place, full suite passing.

---

## Critical Rules

- **Reproduce first:** If you cannot reproduce, you cannot debug. Stay in Phase 1.
- **One hypothesis at a time:** Testing multiple theories simultaneously is noise, not signal.
- **Minimal fix:** The fix addresses the root cause and nothing else. No drive-by refactoring.
- **Regression test first:** Write the failing test BEFORE the fix. This proves you understand the bug.
- **No fix-then-understand:** Do not fix the bug before you understand the root cause. The fix will not be right.
- **No shotgun debugging:** If you are trying random changes, you have left the methodology. Go back to Phase 1.

---

## Anti-Patterns (FORBIDDEN)

- Do NOT try random fixes without tracing the call chain -- that is shotgun debugging
- Do NOT skip reproduction -- if you cannot trigger the bug, you cannot verify the fix
- Do NOT fix the bug before writing the regression test -- the test proves you understand the bug
- Do NOT test multiple hypotheses simultaneously -- one at a time, sequentially
- Do NOT refactor, clean up, or improve code while fixing a bug -- minimal fix only
- Do NOT skip the backward trace and jump straight to a fix -- the root cause is almost never at the crash site
- Do NOT declare the bug fixed without running the full test suite -- your fix may break something else
- Do NOT proceed to Phase 4 without confirming the hypothesis in Phase 3 -- an unconfirmed hypothesis leads to wrong fixes

---

## Anti-Rationalization Table

| Rationalization | Why It Is WRONG | Required Action |
|-----------------|-----------------|-----------------|
| "I think I know what's wrong" | Intuition is not evidence. The call chain trace takes minutes and catches wrong assumptions that intuition misses. | **MUST complete Phase 2 trace before forming a hypothesis** |
| "Let me just try this quick fix" | That is shotgun debugging. Quick fixes without root cause understanding introduce new bugs or mask the real issue. | **MUST reproduce first (Phase 1), then trace (Phase 2)** |
| "It works now but I'm not sure why" | You do not have a fix, you have luck. The bug will return under different conditions because the root cause is still there. | **MUST trace backward to root cause and confirm with a test** |
| "I'll refactor this while I'm here" | Refactoring during a bugfix mixes two concerns. If the refactor introduces a new bug, you cannot tell it apart from the original. | **MUST apply minimal fix only. Refactor is a separate task** |
| "The bug is obvious" | Then the trace should take 30 seconds. Do it anyway. Obvious bugs that skip the trace are the ones that get fixed wrong. | **MUST complete the 4-phase process regardless of perceived simplicity** |
| "I can't reproduce it" | Then you cannot debug it yet. Proceeding without reproduction means you cannot verify any fix. | **MUST stay in Phase 1. Get more data: logs, environments, inputs** |
| "The test suite is slow so I'll skip the full run" | A fix that breaks something else is not a fix. The suite run is the only way to catch downstream consequences. | **MUST run the full test suite in Phase 4** |
| "I'll write the test after the fix" | Writing the test after means you cannot prove the test catches the bug. It might pass for the wrong reason. | **MUST write the failing test BEFORE implementing the fix** |
