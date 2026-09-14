---
name: rigor:architecture-review
description: >-
  Assess a repository's current architecture through read-only evidence gathering,
  parallel domain analysis, and prioritized findings. Use for architecture
  baselines, major milestones, technical-debt assessment, and pre-release
  health checks. Skip for reviewing a narrow git diff (use rigor:review) or
  mapping code without architectural judgment (use rigor:explore).
---

Run an evidence-backed, read-only architecture assessment of the current repository. Map the implemented system before judging it; then report risks and recommendations with file-and-line evidence.

**Read-only boundary:** Do not edit files, create artifacts, remediate findings, modify repository settings, commit, or open pull requests. Report solely in the current session.

**Announce at start:** "Using rigor:architecture-review to assess the current architecture."

---

## Step 0 -- Define the Assessment

Confirm or state the target repository, assessment goal, and scope. Default scope is the entire current repository.

Choose the applicable lenses:

| Lens | Examine |
|------|---------|
| System structure | Modules, responsibilities, dependency direction, public boundaries |
| Runtime flows | Startup, request/tool flow, state changes, error paths, shutdown |
| State and data | Ownership, persistence, atomicity, migrations, consistency |
| Concurrency and resilience | Locks, races, retries, timeouts, recovery, failure isolation |
| Security and operations | Trust boundaries, secrets, permissions, logging, observability, CI/CD |
| Evolution and quality | Test seams, coupling, duplication, extension cost, documentation drift |

If the user supplies a particular concern, make it a required lens. If the repository or objective is ambiguous, ask before analysis.

---

## Step 1 -- Establish Facts Before Judging

Read repository guidance and obtain a baseline without changing state:

```bash
git status --short
git log --oneline -10
```

Inspect top-level structure, build manifests, runtime entry points, test configuration, CI/workflow configuration, and relevant existing documentation. Identify languages and load applicable `rigor:lang:*` packs.

Report an assessment context banner:

```
Architecture Review Context
---------------------------
Repository: <path>
Revision:   <short SHA>
Scope:      <full repository or user scope>
Stack:      <languages and frameworks>
Lenses:     <selected lenses>
Baseline:   <clean/dirty, CI/test configuration>
```

Do not infer a design from directory names alone. Every architecture claim must be supported by code, configuration, tests, or runtime wiring.

---

## Step 2 -- Map the Current System in Parallel

Dispatch independent read-only analysis agents in one batch. Scale the batch to the repository; do not use agents whose domain has no evidence in the target.

Required assignments for a full-repository assessment:

1. **Structure and dependencies:** Components, responsibilities, import/dependency direction, cycles, boundary violations, and an ASCII dependency map.
2. **Runtime and state:** Entrypoints, key execution flows, persistence/state ownership, lifecycle transitions, recovery behavior, and failure paths.
3. **Resilience and security:** Concurrency controls, atomicity, retries, timeout/cancellation handling, input/trust boundaries, credentials, permissions, and observability.
4. **Evolution and quality:** Test architecture, integration seams, coupling, duplication, configuration/CI, documentation drift, and cost of likely changes.

Every agent must return:
- Observed facts with `file:line` evidence
- Strengths worth preserving
- Risks, categorized by severity
- Uncertainties or unverified assumptions
- Recommended follow-up investigation, if any

Agents must not propose code changes as completed work or edit repository files.

---

## Step 3 -- Validate Material Findings

For every candidate high or critical finding:

1. Trace the full relevant call/dependency path, not one isolated line.
2. Separate a confirmed defect from a design trade-off or missing preference.
3. Check tests, runtime configuration, and recent history when they could contradict the finding.
4. State the operational consequence: failure mode, affected boundary, and realistic trigger.

Discard findings that lack evidence or represent intentional, documented design. Do not convert stylistic preferences into architecture risks.

Severity definitions:

| Severity | Meaning |
|----------|---------|
| Critical | Likely system-wide failure, data/security compromise, or unrecoverable operational impact |
| High | Material correctness, resilience, security, or scaling risk on an expected path |
| Medium | Clear maintainability or extension risk with bounded current impact |
| Low | Local improvement with limited architectural consequence |
| Observation | Verified strength, trade-off, or follow-up question; not a defect |

---

## Step 4 -- Produce the Architecture Review

Return one report in this structure:

```markdown
# Architecture Review

## Executive Summary
- Overall posture: <sound / mixed / at risk>
- Top risks: <up to three findings>
- Strengths to preserve: <up to three evidence-backed strengths>

## System Map
<ASCII component/dependency diagram>

## Architecture Assessment
### Structure and boundaries
### Runtime and state
### Resilience and security
### Evolution and delivery

## Findings
### [Critical|High|Medium|Low] <title>
- **Evidence:** `path/file.ts:42`, ...
- **Why it matters:** <concrete consequence>
- **Trigger:** <realistic condition>
- **Recommendation:** <smallest effective next action>
- **Validation:** <how to prove the concern is addressed>

## Prioritized Roadmap
1. <highest-value action>
2. <next action>
3. <later action>

## Open Questions and Confidence Limits
- <what could not be verified and why>
```

Recommendations must be specific enough to plan, but this skill does not write a plan. Suggest `rigor:plan` for approved multi-file remediation and `rigor:debug` for an active failure.

---

## Anti-Patterns (FORBIDDEN)

- Do NOT edit files, write reports to disk, change settings, or remediate findings.
- Do NOT assess only the directory tree; trace real imports and runtime paths.
- Do NOT call a preference a defect without a concrete consequence.
- Do NOT issue high/critical findings without corroborating evidence across the relevant path.
- Do NOT duplicate diff review; use `rigor:review` for change-specific review.
- Do NOT omit strengths, uncertainties, or evidence locations.
- Do NOT recommend broad rewrites when a bounded improvement addresses the demonstrated risk.

---

## Anti-Rationalization Table

| Rationalization | Why It Is WRONG | Required Action |
|-----------------|-----------------|-----------------|
| "The directory structure explains the architecture." | Names are intent, not proof of dependency or runtime behavior. | Trace imports, entrypoints, and state flow before concluding. |
| "This coupling looks bad, so it is a high-severity issue." | Severity comes from a realistic impact, not taste. | Identify trigger, consequence, and affected boundary. |
| "One suspicious line proves a systemic problem." | Architecture failures occur along paths; isolated code may be guarded. | Trace the entire relevant call or dependency path. |
| "I can fix it while reviewing." | Editing destroys the independent assessment and mixes evidence with remediation. | Report the finding; hand off to `rigor:plan` or `rigor:debug`. |
| "The review needs a saved document to be useful." | Unrequested artifacts create stale documentation and alter the repository. | Report in-session; write a document only when explicitly requested. |
| "No architecture issue was found because tests pass." | Tests establish behavior coverage, not necessarily boundaries or operational resilience. | Assess structure, runtime, and operations independently. |
