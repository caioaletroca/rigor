# Software Domain Pack

The software domain pack provides default Gate 0 checks for software development projects: test execution with coverage metrics and lint enforcement.

## What It Provides

- **tests** check: runs the lang pack's test command and parses coverage against an 85% threshold
- **lint** check: runs the lang pack's lint command
- **require_test_files**: enabled by default

All commands use `${lang.*}` variable placeholders resolved by the active lang pack.

## Detection Signals

The `rigor:init` skill detects the software domain by looking for:

| Signal | Confidence |
|--------|------------|
| Code files: `.ts`, `.js`, `.go`, `.py`, `.cs`, `.java`, `.rs` | high |
| Package managers: `package.json`, `go.mod`, `requirements.txt`, `pyproject.toml`, `*.csproj`, `*.sln`, `Cargo.toml` | high |
| CI configs: `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile` | medium |
| Test directories: `test/`, `tests/`, `__tests__/`, `*_test.go` | medium |

Any single high-confidence signal is sufficient. Two or more medium-confidence signals together also qualify.

## Available Lang Packs

| Language | Pack | Variables Provided |
|----------|------|--------------------|
| Go | `rigor:lang:go` | `lang.test_command`, `lang.lint_command`, `lang.coverage_pattern` |
| TypeScript | `rigor:lang:ts` | `lang.test_command`, `lang.lint_command`, `lang.coverage_pattern` |
| C# | `rigor:lang:csharp` | `lang.test_command`, `lang.lint_command`, `lang.coverage_pattern` |
| Python | `rigor:lang:py` | `lang.test_command`, `lang.lint_command`, `lang.coverage_pattern` |
| React | `rigor:lang:react` | `lang.test_command`, `lang.lint_command`, `lang.coverage_pattern` |

When no lang pack is active, `${lang.*}` placeholders remain unresolved and the corresponding checks are skipped.

## Domain Skills

Beyond Gate 0 checks, the software pack ships domain-scoped skills under `skills/domain/software/skills/`. These install as slash commands only when `domain: software` is active.

| Skill | What it does |
|-------|-------------|
| `rigor:worktree` | Creates an isolated, collision-free git worktree for parallel branch work: directory-priority selection, `.gitignore` safety, dependency install, a baseline test against the configured Gate 0 command, and one-agent-per-worktree naming rules so multiple agents can share a repo without colliding. |
