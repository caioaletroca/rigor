---
name: rigor:test-guard
description: >-
  Test quality guard — catches mock abuse, test-only production methods, and
  testing anti-patterns before they enter the codebase. Three iron laws
  enforced. Runs during test writing to prevent poor test quality at the
  source. Use before committing tests, during TDD cycles, or at review time
  when test quality is in question. Skip when changes contain no test code.
---

Guard test quality by enforcing three iron laws and detecting five anti-patterns before tests enter the codebase. Read-only analysis — reports violations without auto-fixing.

**Announce at start:** "Using rigor:test-guard to check test quality."

---

## THREE IRON LAWS

These are non-negotiable. Any violation is a hard gate failure.

| # | Iron Law | Violation Means |
|---|----------|-----------------|
| 1 | **NEVER test mock behavior — test REAL behavior** | The test asserts on mock internals (call count, argument capture, mock IDs) instead of observable output or state change |
| 2 | **NEVER add test-only methods to production classes/types** | A method, field, or exported symbol exists in production code but is referenced exclusively from test files |
| 3 | **NEVER mock without understanding the dependency** | A dependency is mocked without the author being able to explain what it does, what side effects it has, or why it exists |

---

## Step 0 -- Identify Test Scope

Determine which files are test files and which are production files in the current diff or working tree. Use language conventions:

| Language | Test file pattern |
|----------|-------------------|
| Go | `*_test.go` |
| TypeScript / JavaScript | `*.test.ts`, `*.spec.ts`, `*.test.js`, `*.spec.js`, `__tests__/*` |
| C# | `*.Tests.cs`, `*Tests/*.cs`, `*.Test.cs`, files in `*.Tests` projects |
| Python | `test_*.py`, `*_test.py`, `tests/*` |
| Rust | `#[cfg(test)]` modules, `tests/` directory |

If there are no test files in scope, STOP. Report: "No test files in scope. Nothing to guard." Do NOT run the anti-pattern catalog on production-only changes.

---

## Step 1 -- Run Anti-Pattern Catalog

For each test file in scope, check for the following five anti-patterns. Each pattern has a description, a gate question, and a fix pattern.

### Anti-Pattern 1: Testing Mock Behavior

**Description:** Tests that verify a mock was called rather than verifying real behavior. The test passes when the mock is wired correctly, not when the system works correctly.

**Gate question:** "Am I testing real behavior or mock existence?"

**Red flags:**
- Assertions on `.call_count`, `.CalledWith`, `.toHaveBeenCalledTimes`, `mock.Verify`, `Times.Once`
- Assertions on test IDs containing `*-mock` or `mock-*`
- Test fails when mock is removed but production code is unchanged — the test was testing the mock
- `assert` or `expect` statements that only reference mock objects, never real output

**Fix pattern:** Assert on output or state, not on `mock.call_count`. If the function returns a value, assert on the value. If it changes state, assert on the state. The mock is plumbing, not the subject.

---

### Anti-Pattern 2: Test-Only Production Methods

**Description:** Adding methods, fields, or exported symbols to production code that exist solely to make tests easier. These pollute the production API surface and couple tests to internals.

**Gate question:** "Does this method serve any production purpose?"

**Red flags:**
- Methods named `GetInternalState()`, `SetTestMode()`, `ForTesting()`, `TestHelper()`, `_debug_*`
- Exported fields or methods in production code referenced only from `_test.go`, `*.test.ts`, or equivalent
- `//go:build !production` or `#if DEBUG` guards wrapping methods used by tests
- Boolean parameters like `isTest` or `testMode` in production constructors

**Fix pattern:** Put test utilities in test files or a `testutils`/`test-utils` package. Use interfaces for seams, not test-only methods. If you need internal access, your design has a testability problem — fix the design, not the API.

---

### Anti-Pattern 3: Mocking Without Understanding

**Description:** Mocking a dependency without understanding what it does, what side effects it has, or why it is there. The mock becomes a black box that silently diverges from real behavior.

**Gate question:** "Can I explain what this dependency does without reading its code?"

**Red flags:**
- Mock setup that returns hardcoded values without comments explaining why those values are realistic
- Mocking a dependency that has no interface — the author created a mock for a concrete type they do not understand
- Comments like "mock this for now", "not sure what this returns", "copied mock from another test"
- Mock returns empty/zero values for fields the real dependency always populates
- "Mocking just to be safe" or "Mocking for isolation" without a concrete reason

**Fix pattern:** Read the dependency. Understand its contract. Then decide if mocking is appropriate. If you cannot explain the mock's return values, you do not understand the dependency well enough to mock it.

---

### Anti-Pattern 4: Incomplete Mocks

**Description:** Mocking a data structure but only including fields the test uses, not the full shape. The test passes with a partial mock but fails in production when the real data has additional fields, nested objects, or edge-case values.

**Gate question:** "Does my mock match the real API response/data shape?"

**Red flags:**
- Mock objects with 2-3 fields when the real type has 10+
- Missing `null`/`nil` fields that the real API sometimes returns
- Mock setup longer than 50% of the test body (often a sign of fighting the mock, not understanding the data)
- Tests that pass with the mock but fail against a real instance or fixture

**Fix pattern:** Check the real API, type definition, or schema. Include ALL fields. Use fixtures or factories that produce complete objects. Partial mocks hide integration bugs that surface in production.

---

### Anti-Pattern 5: Integration Tests as Afterthought

**Description:** Writing unit tests first, getting green, then trying to add integration tests that reveal the units do not work together. The unit tests gave false confidence.

**Gate question:** "Did I think about the integration boundary before writing unit tests?"

**Red flags:**
- A PR with 100% unit test coverage but zero integration tests for code that crosses service/module boundaries
- Unit tests mock every external call, and no integration test verifies the real interaction
- Tests that pass individually but fail when run together (shared state, ordering assumptions)
- Database/API interaction code with only unit tests — no test hits a real database or HTTP endpoint

**Fix pattern:** TDD from the outside in. Start with what the user or caller sees. Write a failing integration test for the boundary, then drill down into unit tests for internal logic. The integration test is the anchor; unit tests are the details.

---

## Step 2 -- TDD Prevention Check

TDD naturally prevents mock-testing because the RED step forces thinking about WHAT you are testing, not HOW to mock it. Check whether the test follows TDD structure:

| Signal | Indicates |
|--------|-----------|
| Test written before implementation (commit history shows test first) | TDD — lower anti-pattern risk |
| Test written after implementation | Higher risk of mock abuse — scrutinize more carefully |
| Test only asserts on mocks with no observable behavior check | Almost certainly violates Iron Law 1 |
| Test requires complex mock setup to run at all | May indicate missing interface or design problem |

If TDD evidence is present, note it as a positive signal but still run all anti-pattern checks. TDD reduces risk; it does not eliminate it.

---

## Step 3 -- Report

Produce a structured report in the current session. Do NOT save to disk. Do NOT edit any files.

### Output Format

```markdown
## Test Guard Report

**Verdict:** [PASS | FAIL]
**Test files scanned:** [count]
**Production files checked for test-only methods:** [count]
**Iron law violations:** [count]
**Anti-pattern detections:** [count]

## Iron Law Violations

[If none: "None."]

| # | Law | File | Evidence | Fix |
|---|-----|------|----------|-----|
| 1 | Testing mock behavior | path:line | Assertion on mock.call_count | Assert on return value instead |

## Anti-Pattern Detections

[If none: "None."]

| # | Anti-Pattern | File | Gate Question Answer | Severity | Fix |
|---|-------------|------|---------------------|----------|-----|
| 1 | Incomplete Mocks | path:line | Mock has 3 of 12 fields | high | Use complete fixture from schema |

## TDD Signals

[Positive or negative signals observed]

## Verdict Rationale

[Why the verdict is PASS or FAIL]
```

### Verdict Rules

| Condition | Verdict |
|-----------|---------|
| Any iron law violation | **FAIL** |
| 2+ anti-pattern detections at high severity | **FAIL** |
| Anti-pattern detections at medium/low only | **PASS** (with warnings) |
| No violations, no detections | **PASS** |

---

## Anti-Patterns (FORBIDDEN)

- Do NOT auto-fix test code — this skill is report-only, like `rigor:review`
- Do NOT skip Iron Law checks — all three are checked on every run, no exceptions
- Do NOT accept "we mock everything in this project" as justification — project-wide mock abuse is a project problem, not a justification for more
- Do NOT ignore test-only production methods because they are "just getters" — a getter that only tests call is still test pollution
- Do NOT treat high mock-setup-to-assertion ratio as acceptable when the mocks are "well-structured" — volume of mock setup is a smell regardless of formatting
- Do NOT waive Iron Law 1 for "interaction testing" — interaction testing verifies collaborator contracts, not mock call counts
- Do NOT skip the integration test check because "unit tests cover everything" — unit tests with mocked boundaries prove nothing about real integration
- Do NOT report mock usage as a violation by itself — mocks are tools; the violation is mocking without understanding or testing the mock instead of the behavior
- Do NOT run on production-only changes — Step 0 exists to scope the guard to test files

---

## Anti-Rationalization Table

| Rationalization | Why It Is WRONG | Required Action |
|-----------------|-----------------|-----------------|
| "We need mocks for fast tests" | Mock the I/O boundary, not the domain logic. Fast tests that test mocks are fast tests that test nothing. | **MUST mock only at I/O boundaries and assert on real behavior** |
| "The real dependency is complex" | Complexity is a reason to understand it better, not to mock it blindly. A mock of something you do not understand diverges silently. | **MUST read and understand the dependency before mocking** |
| "This test-only method is just a getter" | It is still coupling tests to internals. Today it is a getter; tomorrow it is a backdoor that hides real bugs. | **MUST move test utilities out of production code** |
| "Our coverage would drop without this mock test" | Coverage of mock behavior is not coverage. A test that verifies `mock.Called()` covers nothing real. Removing it makes coverage honest. | **MUST replace mock-behavior tests with real-behavior tests** |
| "We mock everything in this project" | That is a project problem, not a justification. Every new mock test makes the problem worse. Start fixing it here. | **MUST evaluate each mock individually against Iron Law 3** |
| "Interaction testing requires checking mock calls" | Real interaction testing verifies that collaborators fulfill their contracts, not that a mock's `.Verify()` passes. | **MUST assert on the contract output, not the mock wiring** |
| "The integration test is too slow to run in CI" | Then run it in a separate stage, not never. Skipping integration tests because they are slow means skipping the only tests that prove the system works. | **MUST have integration tests, even if in a separate CI stage** |
| "Partial mocks are fine because we only test the fields we use" | The fields you do not mock are the fields that break in production. Partial mocks are silent lies about the real data shape. | **MUST use complete data shapes in mocks and fixtures** |
