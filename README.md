# Rigor

**Deterministic quality gate enforcement for AI-assisted development, via MCP.**

Rigor is an MCP server that sits between your AI coding agent and your codebase. It makes sure the agent actually does the work (runs the tests, passes the linter, gets the review) before moving on. No skipping steps, no "I'll do it later," no vibes-based quality.

Think of it as a state machine with opinions: your agent writes the code, Rigor checks the receipts.

## Why Rigor exists

AI coding agents are great at writing code. They're less great at discipline. Left unchecked, they'll skip tests, ignore lint warnings, and mark tasks as "done" based on... well, optimism.

Rigor fixes this by splitting responsibilities:

- **Your agent** handles creativity: writing code, reviewing architecture, debugging
- **Rigor** handles accountability: enforcing gates, collecting evidence, refusing to advance until criteria are met

The key insight: quality enforcement should be **deterministic code**, not prompt instructions an LLM can rationalize away. You wouldn't enforce auth with a comment that says "please check the password." Same principle.

## Quick start

### Install

```bash
npm install
npm run build
```

### Install skills

Use the CLI to install Rigor's workflow skills into your AI coding tool:

```bash
# Claude Code
rigor install --client claude --global

# Hermes Agent
rigor install --client hermes --global

# OpenCode
rigor install --client opencode --global
```

This gives you slash commands like `/rigor:cycle`, `/rigor:plan`, `/rigor:review`, etc. For Claude Code and OpenCode, skills are referenced via `@path` (no duplication, auto-updates). For Hermes, skills are copied as self-contained SKILL.md files.

Drop `--global` to install per-project instead. Your AI agent can also call the `install_commands` MCP tool to install skills into a project automatically.

### Configure your MCP client

Add Rigor as an MCP server. Works with Claude Code, OpenCode, Hermes Agent, or any MCP-compatible client.

**Claude Code** (`settings.json`):

```json
{
  "mcpServers": {
    "rigor": {
      "command": "node",
      "args": ["/path/to/rigor/dist/server.js", "--project-root", "/path/to/your/project"]
    }
  }
}
```

**Hermes Agent** (via `hermes mcp add` or directly in `~/.hermes/config.yaml`):

```yaml
mcp_servers:
  rigor:
    command: node
    args:
      - /path/to/rigor/dist/server.js
      - --project-root
      - /path/to/your/project
```

### Initialize a project

```bash
# The init skill detects your domain and tech stack
rigor init
```

This creates `.rigor/config.yaml` with sensible defaults for your project.

### Run a cycle

```
1. Write a plan (or use rigor:plan to generate one)
2. cycle_init(plan_path)        → Load the plan into Rigor
3. task_start(task_id)          → Begin a task (entry criteria checked)
4. ... write code, tests ...
5. task_complete(task_id)       → Gate 0 checks (tests, coverage, lint)
6. review_start(epic_id)       → Start code review (all tasks must pass)
7. review_submit(epic_id, ...) → Gate 8 (reviewer findings aggregated)
8. accept_start(epic_id)       → Start acceptance
9. accept_submit(epic_id, ...) → Gate 9 (criteria mapped, user approves)
10. phase_advance()            → Move to next phase
```

## RTK (recommended)

We recommend using [RTK](https://github.com/rtk-ai/rtk) alongside Rigor. RTK is a token-optimized CLI proxy that reduces token usage by 60-90% on dev operations. Since Rigor's gate checks run shell commands (test suites, linters, coverage tools), their output can be verbose. RTK keeps that under control.

## Gates

Rigor enforces quality through a gate system. Each gate has entry criteria, work, and exit criteria. The server **refuses** to advance if criteria aren't met.

| Gate | Scope | What it checks |
|------|-------|----------------|
| **Gate 0** | Per task | Tests pass, coverage >= threshold, lint clean, test files exist |
| **Gate 1** | Per task (conditional) | Docker config, env vars, health checks (only when infra changes) |
| **Gate 8** | Per epic | Code review: up to 10 reviewer archetypes, finding severity gates |
| **Gate 9** | Per epic | Acceptance: criteria mapped to evidence, user approval |
| **Custom** | Configurable | Shell commands at pre_task, post_task, pre_review, or post_accept |

### Custom gates

Define your own deterministic checks:

```yaml
# .rigor/config.yaml
gates:
  custom:
    pre_task:
      - name: "migration-safety"
        command: "atlas schema diff"
    post_task:
      - name: "api-compat"
        command: "buf breaking --against .git#branch=main"
```

## MCP tools

### Cycle lifecycle

| Tool | Description |
|------|-------------|
| `cycle_init` | Parse a plan.md and initialize cycle state |
| `cycle_reload` | Re-parse the plan and merge new phases/epics/tasks into the running cycle (rolling-wave elaboration) without losing progress |
| `cycle_status` | Current progress, active task, phase info |

### Gate enforcement

| Tool | Description |
|------|-------------|
| `task_start` | Validate entry criteria, begin task |
| `task_complete` | Run Gate 0 exit checks |
| `review_start` | Start epic review (all tasks must pass) |
| `review_submit` | Submit reviewer findings for Gate 8 |
| `accept_start` | Start acceptance for epic |
| `accept_submit` | Map criteria to evidence for Gate 9 |
| `phase_advance` | Advance to next phase |

### Recovery

| Tool | Description |
|------|-------------|
| `cycle_diagnose` | Validate state, detect stuck entities, audit evidence |
| `cycle_reset` | Reset entire cycle (preview/confirm pattern) |
| `task_manage` | Force status, skip, retry, or reset evidence for a task |
| `epic_manage` | Force status, reset tasks, or skip an epic (optional cascade) |
| `phase_manage` | Force status or skip a phase (cascades to children) |

### Sync

| Tool | Description |
|------|-------------|
| `sync_status` | Provider health and event counts |
| `sync_retry` | Retry failed events to a provider |
| `sync_replay` | Replay all journal events |
| `sync_enable` | Re-enable a disabled provider |

### Scaffold

| Tool | Description |
|------|-------------|
| `new_lang_pack` | Create a language pack for a new language |
| `new_domain` | Create a domain pack for a new domain |
| `install_commands` | Install Rigor skills as slash commands (Claude Code, OpenCode, or Hermes) |

## Configuration

All configuration lives in `.rigor/config.yaml`. Values cascade: **core defaults < domain pack < lang pack < user config**.

```yaml
# Domain and language
domain: software
lang: ts

# Gate thresholds
gates:
  gate_0:
    coverage_threshold: 85
    require_test_files: true
    checks:
      - name: "tests"
        command: "npx vitest run --coverage"
        metric:
          parse: "auto"
          threshold: 85
          label: "coverage"
      - name: "lint"
        command: "npx eslint ."

  gate_8:
    reviewers:
      - code-quality
      - security
      - logic
      - test-quality
      - nil-safety
      - consequences
    required_reviewers:
      - security
      - logic
    max_critical_findings: 0
    max_high_findings: 0

  gate_9:
    require_user_approval: true

# Commit policy
commit:
  gpg_sign: false
  require_scope: true
  types: [feat, fix, chore, docs, refactor, test, style, perf, ci, build]

# Ship policy
ship:
  branch_pattern: "<type>/<description>"
  force_push: "never"

# Sync (optional)
sync:
  enabled: false
  primary: my-jira
  providers:
    my-jira:
      type: jira
      base_url: https://mycompany.atlassian.net
      project_key: RIG
      token: ${JIRA_API_TOKEN}
    gh-projects:
      type: github-projects
      owner: myorg
      repo: myrepo
      project_number: 1
      token: ${GITHUB_TOKEN}
    slack-hook:
      type: webhook
      url: https://hooks.slack.com/...
```

## Domain and language packs

Rigor is **domain-agnostic**. The gate system doesn't care if you're building software, writing papers, or running simulations. A gate is just a command that exits 0 or 1.

**Domain packs** define *what* checks matter (tests, lint, accessibility, etc.).  
**Language packs** define *how* to run those checks (`npx vitest`, `go test`, `pytest`, etc.).

### Shipped domain packs

| Domain | Checks |
|--------|--------|
| `software` | tests, lint, coverage, accessibility, visual regression, e2e, performance |

A domain pack can also ship **domain-scoped skills** under `skills/domain/<domain>/skills/`. These are discovered by `install_commands` and installed as slash commands only when that domain is the active one (a global install surfaces all of them). The `software` pack ships `rigor:worktree` this way.

### Shipped language packs

| Lang | Test | Lint | Extras |
|------|------|------|--------|
| `go` | `go test -race ./...` | `golangci-lint run` | gosec, govulncheck, staticcheck |
| `ts` | `npx vitest run --coverage` | `npx eslint .` | tsc, prettier |
| `react` | `npx vitest run --coverage` | `npx eslint .` | axe-core, playwright, lighthouse, impeccable |
| `py` | `pytest --cov` | `ruff check .` | mypy/pyright |
| `csharp` | `dotnet test --collect:"XPlat Code Coverage"` | `dotnet format --verify-no-changes` | dotnet-security-guard |

Create your own with `new_lang_pack` or `new_domain`.

## Skills

Rigor ships workflow skills that orchestrate the MCP tools:

| Skill | What it does |
|-------|-------------|
| `rigor:cycle` | Drive full dev cycle through gate server |
| `rigor:plan` | Write rolling-wave phased implementation plan |
| `rigor:review` | Hybrid deterministic + AI code review |
| `rigor:commit` | Conventional commits with scope enforcement |
| `rigor:ship` | Branch, commit, push, PR (end to end) |
| `rigor:pr` | Open PR with template and precondition checks |
| `rigor:lint` | Run linter, fix issues, verify clean |
| `rigor:init` | Project onboarding and config generation |
| `rigor:debug` | Systematic 4-phase debugging |
| `rigor:explore` | Two-phase autonomous codebase exploration |
| `rigor:brainstorm` | Socratic design exploration |
| `rigor:receive-review` | Process review feedback with verification |
| `rigor:test-guard` | Catch mock abuse and test anti-patterns |
| `rigor:new-skill` | Scaffold a new skill |

**Domain-scoped skills** live *inside* a domain pack and install as slash commands only when that domain is active. The `software` pack ships:

| Skill | What it does |
|-------|-------------|
| `rigor:worktree` | Create an isolated, collision-free git worktree for parallel branch work (directory-priority selection, `.gitignore` safety, dependency install, baseline test against the configured Gate 0 command, and one-agent-per-worktree naming so multiple agents can share a repo without colliding) |

## Architecture

```
┌─────────────────────────────────────┐
│  AI Agent (Claude, Hermes, etc.)    │
│  Writes code, reviews, tests, fixes │
│  MUST call Rigor tools to advance   │
└──────────────┬──────────────────────┘
               │ MCP Protocol
┌──────────────▼──────────────────────┐
│         Rigor Gate Server           │
│                                     │
│  ┌─────────┐  ┌──────────┐         │
│  │  State   │  │ Evidence │         │
│  │ Machine  │  │ Manager  │         │
│  └────┬─────┘  └────┬─────┘        │
│       │              │              │
│  ┌────▼──────────────▼─────┐       │
│  │    Gate Engine           │       │
│  │  (checks, thresholds,   │       │
│  │   custom commands)      │       │
│  └────┬────────────────────┘       │
│       │                            │
│  ┌────▼─────────────────┐          │
│  │  Sync Layer          │          │
│  │  (Jira, GitHub, Slack)│         │
│  └──────────────────────┘          │
└─────────────────────────────────────┘
```

**State persistence:** `.rigor/state.json` (cycle state), `.rigor/evidence/` (gate artifacts), `.rigor/history/` (completed cycles), `.rigor/sync/events.jsonl` (sync journal).

The state machine enforces transitions. You can't skip Gate 0 to get to Gate 8, and you can't mark a task complete without passing checks. If a session crashes, it resumes from the last persisted state.

## Tech stack

- **Runtime:** Node.js 20+
- **Language:** TypeScript 5.7+
- **Protocol:** MCP (Model Context Protocol)
- **Dependencies:** `@modelcontextprotocol/sdk`, `yaml`
- **Testing:** Vitest

## Docs

For deeper dives:

| Document | What it covers |
|---|---|
| [Why Rigor](docs/why-rigor.md) | The problem, prior art, and where Rigor fits |
| [Architecture](docs/architecture.md) | Two-layer design, MCP server, responsibilities |
| [Gates](docs/gates.md) | Gate catalog, entry/exit criteria, custom gates |
| [Hybrid Approach](docs/hybrid-approach.md) | Core principle, why pure-prompt and pure-code fail |
| [Landscape](docs/landscape.md) | Comparison with Ring, Impeccable, LangGraph, CI |

## License

See [LICENSE](LICENSE) for details.
