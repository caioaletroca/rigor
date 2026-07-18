# Gates

## Overview

Gates are mandatory quality checkpoints in the project cycle. Each gate
has deterministic entry/exit criteria enforced by code, not prompts.

Gates are domain-agnostic: the core gate system runs generic checks defined
by **domain packs** (e.g. `software`) and resolved via **lang pack** variables
(e.g. `react`, `go`, `typescript`). The software domain pack is the primary
example, but the same gate infrastructure works for any domain.

A gate has three parts:

1. **Entry criteria** — preconditions checked before the gate starts
2. **Work** — what happens inside the gate (deterministic, AI, or both)
3. **Exit criteria** — postconditions checked before advancing

## Gate Catalog

### Gate 0: Implementation (per task)

Gate 0 runs a generic list of `checks[]` defined by the active domain pack
and resolved with lang pack variables. The software domain pack provides
checks for tests, lint, accessibility, visual regression, e2e, and
performance. Checks with empty/unresolved commands are skipped automatically.

**Entry criteria (deterministic):**
- Task exists in plan
- Previous task completed (if sequential)
- No uncommitted changes from prior task

**Work (AI):**
- Write failing test (TDD RED)
- Write minimal code to pass (TDD GREEN)
- Refactor (TDD REFACTOR)

**Exit criteria (deterministic):**
- All configured checks pass (command exit code 0)
- Metrics meet thresholds (e.g. coverage >= 85%)
- New files have corresponding test files (when configured)

**Exit criteria (AI -- optional, configurable):**
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

### Frontend Quality Checks (domain pack, via Gate 0)

Frontend quality checks (accessibility, visual regression, e2e, performance)
are defined as checks in the **software domain pack** (`skills/domain/software/defaults.yaml`)
and run through Gate 0's generic check runner. They are not separate gates.

Each check uses a `${lang.*}` variable placeholder. When the lang pack (e.g.
React) provides the corresponding command, the check runs. When the variable
resolves to an empty string (no lang pack loaded, or the lang pack does not
provide that command), Gate 0 skips the check automatically.

**Checks defined in the software domain pack:**

| Check | Variable | React default |
|-------|----------|---------------|
| Accessibility | `${lang.a11y_command}` | `npx axe-core-cli` |
| Visual regression | `${lang.visual_command}` | `npx vitest run --project visual` |
| E2E tests | `${lang.e2e_command}` | `npx playwright test` |
| Performance | `${lang.perf_command}` | `npx lighthouse-ci` |

**Overriding:** Set the command in `.rigor/config.yaml` under
`gates.gate_0.checks` to replace the domain pack defaults entirely, or
provide a lang pack with different variable values.

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
