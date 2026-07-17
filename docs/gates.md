# Gates

## Overview

Gates are mandatory quality checkpoints in the development cycle. Each gate
has deterministic entry/exit criteria enforced by code, not prompts.

A gate has three parts:

1. **Entry criteria** — preconditions checked before the gate starts
2. **Work** — what happens inside the gate (deterministic, AI, or both)
3. **Exit criteria** — postconditions checked before advancing

## Gate Catalog

### Gate 0: Implementation (per task)

**Entry criteria (deterministic):**
- Task exists in plan
- Previous task completed (if sequential)
- No uncommitted changes from prior task

**Work (AI):**
- Write failing test (TDD RED)
- Write minimal code to pass (TDD GREEN)
- Refactor (TDD REFACTOR)

**Exit criteria (deterministic):**
- Tests pass (`go test` / `npm test` exit code 0)
- Coverage >= threshold (parsed from coverage profile)
- No lint errors (`golangci-lint` / `eslint` exit code 0)
- New files have corresponding test files

**Exit criteria (AI — optional, configurable):**
- Code follows project conventions (style review)

---

### Gate 1: Infrastructure (per task, conditional)

**Entry criteria (deterministic):**
- Gate 0 passed for this task
- Task introduces new dependencies or services

**Work (deterministic + AI):**
- Verify docker-compose includes new services
- Verify environment variables documented
- AI checks configuration correctness

**Exit criteria (deterministic):**
- `docker compose config` validates
- All env vars in `.env.example`
- Health check endpoints respond

---

### Gate 2: Accessibility (per task, conditional)

**Entry criteria (deterministic):**
- Gate 0 passed for this task
- Project is a frontend project (next.config.* or .tsx/.jsx files detected)

**Work (deterministic):**
- Run accessibility audit command (default: `npx axe-core-cli`)
- Parse violation count from output

**Exit criteria (deterministic):**
- Violation count <= max_violations (default: 0)
- Command exits with code 0

**Configuration:**
```yaml
gates:
  gate_2:
    enabled: true        # Enable/disable the gate
    required: false      # When false, failures are warnings; when true, failures block
    a11y_command: "npx axe-core-cli"
    max_violations: 0
```

**Behavior:** Opt-in by default. Runs and reports but does not block task
completion unless `required: true` is set. Skipped entirely for non-frontend
projects.

---

### Gate 3: Visual Regression (per task, conditional)

**Entry criteria (deterministic):**
- Gate 0 passed for this task
- Visual/snapshot test files exist (*.visual.{ts,tsx} or *.snapshot.{ts,tsx})

**Work (deterministic):**
- Run visual regression test command (default: `npx vitest run --project visual`)

**Exit criteria (deterministic):**
- Command exits with code 0

**Configuration:**
```yaml
gates:
  gate_3:
    enabled: true
    required: false
    visual_test_command: "npx vitest run --project visual"
```

**Behavior:** Opt-in by default. Only runs when visual/snapshot test files are
detected. Failures are warnings unless `required: true`.

---

### Gate 4: E2E (per task, conditional)

**Entry criteria (deterministic):**
- Gate 0 passed for this task
- E2E test files exist (e2e/**/*.{ts,tsx} or *.e2e.{ts,tsx})

**Work (deterministic):**
- Run end-to-end test command (default: `npx playwright test`)

**Exit criteria (deterministic):**
- Command exits with code 0

**Configuration:**
```yaml
gates:
  gate_4:
    enabled: true
    required: false
    e2e_command: "npx playwright test"
```

**Behavior:** Opt-in by default. Only runs when e2e test files are detected.
Failures are warnings unless `required: true`.

---

### Gate 5: Performance (per task, conditional)

**Entry criteria (deterministic):**
- Gate 0 passed for this task
- Next.js config file exists (next.config.*)

**Work (deterministic):**
- Run performance command (default: `npx lighthouse-ci`)
- Parse performance score from output if available
- Compare score against min_score threshold

**Exit criteria (deterministic):**
- Command exits with code 0
- Performance score >= min_score (default: 90)

**Configuration:**
```yaml
gates:
  gate_5:
    enabled: true
    required: false
    perf_command: "npx lighthouse-ci"
    min_score: 90
    budget_file: ""       # Optional path to budget.json
```

**Behavior:** Opt-in by default. Only runs for Next.js projects. When
`budget_file` is set, it is passed as `--budget-path` to the performance
command. Failures are warnings unless `required: true`.

---

### Gate 8: Review (per epic)

**Entry criteria (deterministic):**
- All tasks in epic passed Gate 0
- Epic diff exists (git diff base..HEAD)

**Work (AI):**
- Dispatch parallel reviewer agents:
  - Code quality reviewer
  - Security reviewer
  - Logic/correctness reviewer
  - Test quality reviewer
  - Performance reviewer
- Each reviewer returns structured findings

**Exit criteria (deterministic):**
- All required reviewers submitted findings
- Zero critical/high severity findings remain unresolved

**Exit criteria (AI):**
- Reviewer consensus: PASS (aggregated from all reviewers)

---

### Gate 9: Acceptance (per epic)

**Entry criteria (deterministic):**
- Gate 8 passed for this epic
- All review findings resolved

**Work (deterministic + AI):**
- AI maps each acceptance criterion to code evidence
- Server validates all criteria have mapped evidence

**Exit criteria (deterministic):**
- All acceptance criteria have evidence entries
- User explicitly approved (interactive prompt or API)

---

### Phase Boundary (per phase)

**Entry criteria (deterministic):**
- All epics in phase passed Gate 9
- Phase state is "in_progress"

**Work (AI):**
- Elaborate next phase tasks (rolling-wave planning)
- Generate phase summary

**Exit criteria (deterministic):**
- Next phase has tasks defined
- Phase state updated to "completed"
- Next phase state set to "detailed"

---

### Cycle Completion

**Entry criteria (deterministic):**
- All phases completed
- No tasks in "blocked" or "in_progress" state

**Work (deterministic + AI):**
- Deterministic: validate all gate evidence files exist
- Deterministic: check for uncommitted changes
- AI: generate dev report (metrics, decisions, issues)

**Exit criteria (deterministic):**
- All evidence files present
- Working tree clean
- Dev report generated

## Custom Gates

Gates are defined in configuration. Teams can:

- Add custom gates between any existing gates
- Define custom deterministic checks (shell commands with exit codes)
- Define custom AI checks (reviewer agent specifications)
- Set per-project thresholds (coverage %, required reviewers, etc.)

```yaml
# .rigor/config.yaml
gates:
  gate_0:
    coverage_threshold: 85
    lint_command: "golangci-lint run ./..."
    test_command: "go test -coverprofile=coverage.out ./..."
    require_test_files: true

  gate_8:
    reviewers:
      - code-quality
      - security
      - logic
      - test-quality
    required_reviewers: ["security", "logic"]
    max_critical_findings: 0
    max_high_findings: 0

  gate_9:
    require_user_approval: true

  # Custom gate example
  gate_custom_migration:
    after: gate_0
    condition: "changed_files_match('*.sql')"
    checks:
      - command: "sqlfluff lint migrations/"
        name: "SQL lint"
      - command: "atlas schema diff"
        name: "Migration safety"
```
