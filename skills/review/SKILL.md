---
name: rigor:review
description: >-
  Dispatch parallel code reviewers over a git diff with hybrid deterministic +
  AI analysis. Detects project language, runs security/static-analysis tools
  from the matching lang pack first, then dispatches AI reviewer agents with
  tool findings as grounding context. Aggregates all findings by severity and
  returns a verdict. Report-only -- never edits files or remediates findings.
  Use at Gate 8 (per epic), before merging, or after completing a feature.
  Skip when there are no code changes or the diff is documentation-only.
---

Run a hybrid code review: deterministic tools first for grounded evidence, then AI reviewers in parallel for judgment. Aggregate all findings into a single severity-ranked report with a pass/fail verdict.

**Report-only boundary:** This skill does not remediate findings, edit files, dispatch implementation agents, re-run reviewers, or create artifacts on disk. It dispatches reviewers once and reports their findings in the current session.

**Announce at start:** "Using rigor:review to run hybrid code review."

---

## HARD STOP -- VERIFY DIFF EXISTS

Before anything else, confirm there are changes to review:

```bash
git diff --stat <base>..HEAD
```

If the diff is empty, STOP. Report: "No changes to review." Do NOT dispatch reviewers on an empty diff.

---

## Step 0 -- Load Config and Detect Language

### 0.1 -- Load Review Config

Read `.rigor/config.yaml` from the repository root. Extract `gates.gate_8`:

| Key | Default | Effect |
|-----|---------|--------|
| `reviewers` | `[code-quality, security, logic, test-quality]` | Which AI reviewers to dispatch |
| `required_reviewers` | `[security, logic]` | MUST submit findings for the gate to pass |
| `max_critical_findings` | `0` | Gate fails if unresolved critical exceeds this |
| `max_high_findings` | `0` | Gate fails if unresolved high exceeds this |

If the file does not exist, use all defaults. Do NOT prompt the user to create one.

### 0.2 -- Detect Language and Load Lang Packs

Inspect the diff's file extensions to detect languages. For each detected language, check if a lang pack exists at `skills/lang/<language>/SKILL.md` (resolved relative to rigor's install path).

| Extension | Language | Lang Pack |
|-----------|----------|-----------|
| `.go` | Go | `rigor:lang:go` |
| `.ts`, `.tsx`, `.js`, `.jsx` | TypeScript | `rigor:lang:ts` |
| `.cs` | C# | `rigor:lang:csharp` |
| `.py` | Python | `rigor:lang:py` |
| `.rs` | Rust | `rigor:lang:rust` |

If a lang pack exists, load it. Extract:
- **Gate 8: Review Tools** -- deterministic tools to run in Step 2
- **Gate 8: Review Patterns** -- focus-area patterns to inject into reviewer prompts in Step 3

If no lang pack exists for the detected language, skip the deterministic tool phase and dispatch reviewers with the diff only. Review still works -- it just has less grounding.

Multiple languages in one diff: load all matching packs. Each reviewer receives patterns from all loaded packs.

---

## Step 1 -- Gather Context

Auto-detect the review range. The base ref may be provided by an orchestrating skill (e.g., `rigor:cycle`). Resolve in this order:

```bash
# 1. Provided by orchestrator (e.g., epic base SHA)
# 2. Upstream tracking ref
git rev-parse @{u} 2>/dev/null

# 3. Default branch
gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null

# 4. Fallback: origin/main
```

Gather:

```bash
git diff --name-only <base>..HEAD          # changed files
git diff --stat <base>..HEAD               # summary
git diff <base>..HEAD                      # full diff for reviewers
git log --oneline <base>..HEAD             # commit history
```

Display a context banner before proceeding:

```
Review Context
--------------
Base:    <base_sha>
Head:    <head_sha>
Files:   <count> changed
Commits: <count>
Languages detected: Go, TypeScript
Lang packs loaded:  rigor:lang:go, rigor:lang:ts
Reviewers:          code-quality, security, logic, test-quality
```

---

## Step 2 -- Run Deterministic Tools

For each loaded lang pack, run the tools listed in its **Gate 8: Review Tools** section.

### Execution Order

Run tools grouped by focus area. Within each group, tools run sequentially (some depend on the same build artifacts). Groups are independent and can run in parallel if the harness supports it.

| Focus Area | Tools (from lang pack) |
|------------|------------------------|
| Security | Security scanners (e.g., `gosec`, `govulncheck` for Go) |
| Static analysis | Static analyzers (e.g., `staticcheck`, `go vet` for Go) |
| Performance | Performance profilers (e.g., `benchstat` for Go) |

### Tool Failure Policy

| Situation | Action |
|-----------|--------|
| Tool not installed | Log warning, skip that tool, continue |
| Tool exits non-zero with findings | Capture output as findings -- this is expected |
| Tool crashes or times out (>60s) | Log error, skip that tool, continue |
| No lang pack loaded | Skip entire Step 2, proceed to Step 3 |

Tools are **grounding inputs** for AI reviewers, not gates themselves. A missing tool means reviewers have less evidence for that focus area, not that review is blocked.

### Capture Output

For each tool that runs, capture its output in a structured block to pass to reviewers:

```
=== Tool: gosec ===
Exit code: 1 (findings present)
Output:
[tool's stdout/stderr]
===
```

---

## Step 3 -- Dispatch AI Reviewers in Parallel

### Available Reviewers

| Name | Focus Area | What It Reviews |
|------|-----------|-----------------|
| `code-quality` | Architecture, design, naming, structure | Design patterns, code organization, naming conventions, complexity, duplication |
| `security` | Vulnerabilities, injection, secrets, access | OWASP risks, injection vectors, authentication, authorization, crypto usage |
| `logic` | Correctness, edge cases, error handling | Business logic, nil safety, concurrency, error paths, type safety |
| `test-quality` | Coverage, assertions, isolation | Test completeness, assertion quality, test independence, edge case coverage |
| `nil-safety` | Null/nil pointer safety | Traces nil/null/undefined dereference risks through call chains, missing guards, unsafe type assertions, optional chaining that hides bugs, API response fields that could be null |
| `consequences` | Ripple effects beyond changed files | Traces how changes propagate through caller chains, consumer contracts, shared state, implicit dependencies — finds breakage invisible in isolated file review |
| `dead-code` | Orphaned and unreachable code | Identifies code that became unused as a consequence of changes: orphaned functions, unreachable branches, unused imports, stale type definitions, abandoned test helpers |
| `performance` | Code-level and runtime hotspots | Allocations in hot paths, unbounded goroutines/promises, N+1 queries, event loop blocking, synchronous I/O in async handlers, missing caching opportunities |
| `requirements` | Plan compliance and acceptance criteria | Cross-references the implementation against the plan's "Done when" criteria, verifies each criterion has concrete evidence (test, code, behavior), flags criteria without proof |

Only the reviewers listed in `gates.gate_8.reviewers` are dispatched. The table above defines what each reviewer does -- it is not a hardcoded dispatch list.

### Reviewer Categories

Reviewers are split into two categories:

**Core reviewers** run on every review by default:
- `code-quality`, `security`, `logic`, `test-quality`

**Extended reviewers** add specialized analysis:
- `nil-safety` — most impactful for Go and TypeScript where nil/null/undefined dereferences are common runtime errors
- `consequences` — most impactful for large diffs or refactors where changes ripple beyond the changed files
- `dead-code` — most impactful after refactors, removals, or feature replacements
- `performance` — most impactful for hot-path changes, API handlers, database queries, or loop-heavy code
- `requirements` — most impactful at Gate 8 during a `rigor:cycle`, where a plan defines explicit acceptance criteria

All reviewers follow the same dispatch, schema, and aggregation rules. The distinction is purely organizational — users choose which to enable in `gates.gate_8.reviewers`.

### HARD STOP -- Parallel Dispatch Rules

All reviewers MUST be dispatched in a SINGLE TURN as one atomic batch. No trickle dispatch.

**Forbidden sequences:**
- Dispatch reviewer 1 -> read result -> dispatch reviewer 2
- Dispatch a subset -> wait -> dispatch the rest
- Loop sequentially over the reviewer list

If you find yourself about to dispatch a reviewer AFTER any reviewer has already returned a result: STOP. You violated parallel dispatch. Report the violation and mark the review INCOMPLETE.

### Pre-dispatch count check

Before dispatching, count the reviewers you intend to launch. The count MUST equal the number of reviewers in `gates.gate_8.reviewers`. If it does not match, STOP and reconcile.

### Reviewer Prompt Template

Each reviewer receives this context:

```
You are a {reviewer_name} code reviewer. Analyze the following diff and report
findings using the structured schema below.

FOCUS AREA: {focus_description from Available Reviewers table}

DIFF:
{full git diff}

COMMIT HISTORY:
{git log --oneline}

{if tool findings exist for this focus area:}
TOOL FINDINGS (deterministic, pre-verified):
{tool output blocks from Step 2}
Use these findings as grounding -- verify they are real issues in context,
flag false positives, and identify issues the tools missed.

{if lang pack patterns exist for this focus area:}
LANGUAGE-SPECIFIC PATTERNS TO CHECK:
{patterns section from lang pack matching this reviewer's focus area}

OUTPUT: Return a JSON object following the findings schema below. Report
every issue you find. If no issues: return the schema with an empty
findings array.
```

### Requirements Reviewer: Additional Context

The `requirements` reviewer receives extra context beyond the diff:

```
PLAN CONTEXT:
{plan's epic/task "Done when" criteria for the entities under review}

EVIDENCE MAPPING INSTRUCTIONS:
For each acceptance criterion, determine whether the diff provides concrete
evidence that the criterion is met. Evidence includes:
- A test that directly validates the criterion
- Code that implements the required behavior
- Configuration that enables the required feature

For each criterion, report:
- MET: criterion has concrete evidence (cite file:line)
- UNMET: no evidence found in the diff
- PARTIAL: some evidence but incomplete

If no plan context is available, skip this reviewer silently.
```

The `requirements` reviewer's findings use the same schema as other reviewers. Unmet criteria are reported as `high` severity. Partial criteria are reported as `medium`. A finding's `title` is the criterion text and `description` explains what evidence is missing.

### Findings Schema

This is the contract between reviewers and the aggregation step. Every reviewer MUST return this structure:

```json
{
  "reviewer": "<reviewer-name>",
  "verdict": "PASS | ISSUES_FOUND",
  "findings": [
    {
      "severity": "critical | high | medium | low",
      "file": "<path>:<line> or global",
      "title": "<short description>",
      "description": "<what is wrong and why>",
      "suggestion": "<how to fix>",
      "source": "ai | tool:<tool-name>"
    }
  ]
}
```

The `source` field distinguishes AI-originated findings from tool-confirmed findings. Tool findings that a reviewer validates get `source: "tool:<name>"`. New findings the reviewer discovers get `source: "ai"`.

---

## Step 4 -- Collect and Aggregate

### 4.1 -- Check Submission Completeness

For each reviewer in `gates.gate_8.required_reviewers`:
- If the reviewer returned a valid findings object: proceed
- If the reviewer failed or returned no output: STOP. Report which reviewer failed. The gate is INCOMPLETE.

Non-required reviewers that fail are logged as a warning but do not block.

### 4.2 -- Merge Findings

Combine all findings from all reviewers into a single list. Preserve the `reviewer` and `source` fields for traceability. Sort by severity: critical first, then high, medium, low.

### 4.3 -- Apply Verdict

Count unresolved findings by severity:

| Condition | Verdict |
|-----------|---------|
| `critical_count > max_critical_findings` OR `high_count > max_high_findings` | **FAIL** |
| All reviewers submitted, counts within thresholds | **PASS** |
| Any required reviewer missing | **INCOMPLETE** |

---

## Step 5 -- Report

Produce a structured markdown report in the current session. Do NOT save to disk. Do NOT edit any files.

### Output Format

```markdown
## Review Summary

**Verdict:** [PASS | FAIL | INCOMPLETE]
**Base:** [base_sha]
**Head:** [head_sha]
**Files changed:** [count]
**Languages:** [detected languages]
**Lang packs loaded:** [list or "none"]
**Reviewers dispatched:** [count]
**Deterministic tools run:** [count or "none (no lang pack)"]

## Findings by Severity

| Severity | Count |
|----------|-------|
| Critical | N |
| High     | N |
| Medium   | N |
| Low      | N |

## Critical Issues
[List every critical issue. If none: "None."]

| Issue | File | Reviewer | Source | Suggestion |
|-------|------|----------|--------|------------|
| ... | ... | ... | ai/tool:gosec | ... |

## High Issues
[Same format. If none: "None."]

## Medium Issues
[Same format. If none: "None."]

## Low Issues
[Same format. If none: "None."]

## Reviewer Verdicts

| Reviewer | Verdict | Issues | Required |
|----------|---------|--------|----------|
| code-quality | PASS/ISSUES_FOUND | N | no |
| security | PASS/ISSUES_FOUND | N | yes |
| logic | PASS/ISSUES_FOUND | N | yes |
| test-quality | PASS/ISSUES_FOUND | N | no |
| nil-safety | PASS/ISSUES_FOUND | N | no |
| consequences | PASS/ISSUES_FOUND | N | no |
| dead-code | PASS/ISSUES_FOUND | N | no |
| performance | PASS/ISSUES_FOUND | N | no |
| requirements | PASS/ISSUES_FOUND | N | no |

## Report Boundary
No files were changed. No remediation was performed. No artifacts
were saved to disk. This is a read-only review report.
```

---

## Anti-Patterns (FORBIDDEN)

- Do NOT dispatch reviewers sequentially -- all configured reviewers MUST go out in a single turn as one atomic batch
- Do NOT skip the deterministic tool phase when a lang pack is loaded -- tools provide grounding that reduces AI hallucination
- Do NOT edit files or remediate findings -- this skill is report-only
- Do NOT proceed to Step 4 when a required reviewer failed to submit -- the gate is INCOMPLETE, not PASS
- Do NOT run review on an empty diff -- Step 0's diff check exists to prevent this
- Do NOT hardcode the reviewer list -- always read from `gates.gate_8.reviewers` config (or defaults)
- Do NOT suppress low-severity findings from the report -- all findings are reported regardless of severity
- Do NOT re-run reviewers automatically after findings -- that requires a new explicit invocation
- Do NOT call deterministic tools that are not listed in the loaded lang pack -- the lang pack is the source of truth for which tools apply to the language

---

## Anti-Rationalization Table

| Rationalization | Why It Is WRONG | Required Action |
|-----------------|-----------------|-----------------|
| "I will run reviewers one at a time to manage them better" | The skill requires parallel dispatch. Sequential execution doubles latency and defeats the purpose. | **MUST dispatch all reviewers in a single turn** |
| "The security reviewer did not respond but the other three passed" | Security is a required reviewer by default. Missing required reviewer = INCOMPLETE, not PASS. | **MUST mark INCOMPLETE and report the failure** |
| "This high finding is a false positive so I will exclude it" | The reviewer reported it; the skill aggregates it. False-positive triage is the implementer's job after receiving the report. | **MUST include all findings in the report** |
| "No lang pack exists so I will skip the review" | Review works without a lang pack -- AI reviewers still analyze the diff. The lang pack adds grounding but is not required. | **MUST proceed with Step 3 even without a lang pack** |
| "The tools found nothing so the AI reviewers are unnecessary" | Tools catch known patterns. AI catches design flaws, logic errors, and context-dependent issues that tools cannot see. | **MUST dispatch AI reviewers regardless of tool results** |
| "I will fix the issues I found before reporting" | Report-only boundary. Editing files violates the skill's contract and mixes review with implementation. | **MUST report findings without remediation** |
| "The diff is small so I only need one reviewer" | The config determines the reviewer list, not the diff size. Small diffs can have critical security issues. | **MUST dispatch all configured reviewers** |
| "I will save the report to a file for reference" | The skill explicitly does not create artifacts on disk. The report lives in the session. | **MUST report in-session only, no file writes** |
