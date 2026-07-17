# Domain-Agnostic Rigor Core -- Design Document

> **Status:** Approved
> **Date:** 2026-07-17
> **Exploration:** 3 alternatives evaluated

## Context

Rigor's MCP gate server enforces quality gates by running commands and checking
exit codes. This mechanism is accidentally domain-agnostic: the server doesn't
care whether the command is `go test` or `python run_simulation.py`. This design
formalizes that insight, transforming Rigor from a "dev cycle tool" into a
general-purpose agentic project orchestrator with pluggable domain packs.

Software development becomes the first domain pack, not the core identity.

## Core Insight

The universal gate contract is:

```
command  -->  exit code (0 = pass)
          +   stdout   (evidence for the agent to read)
          +   optional number parsed from stdout (threshold comparison)
```

Any validation in any domain can be wrapped in a script that runs a check,
prints a metric, and exits 0 or 1. This is the Unix contract, and it is
sufficient for deterministic enforcement. AI reviewers handle everything
that requires judgment.

## Architecture

### Gate check format

Replace typed, software-specific gate fields with a generic check array:

```yaml
# BEFORE (software-coupled)
gates:
  gate_0:
    test_command: "go test ./..."
    lint_command: "golangci-lint run"
    coverage_threshold: 85

# AFTER (domain-agnostic)
gates:
  gate_0:
    checks:
      - name: "tests"
        command: "go test -coverprofile=coverage.out ./..."
        metric:
          parse: "total:\\s+(\\d+\\.?\\d*)%"
          threshold: 85
          label: "coverage"
      - name: "lint"
        command: "golangci-lint run ./..."
```

Each check is a tuple: `{ name, command, metric? }`. The metric is optional;
when present it defines a regex to parse a number from stdout and a threshold
to compare against. When absent, the gate only checks exit code 0.

### Config precedence

```
User .rigor/config.yaml     (highest -- always wins)
       |
Lang pack defaults           (language-specific tools)
       |
Domain pack defaults         (domain-specific checks)
       |
Core defaults                (lowest -- just "run check, verify exit 0")
```

Same cascade as today with lang packs, extended by one layer.

## Domain Packs

A domain pack is a directory under `skills/domain/<name>/` containing:

| File | Purpose |
|------|---------|
| `DOMAIN.md` | Description, detection signals, documentation |
| `defaults.yaml` | Default gate checks, reviewers, thresholds |
| `reviewers/*.md` | Domain-specific AI reviewer SKILL.md files |

### Detection and init

The `rigor:init` skill auto-detects the domain by scanning the project:

1. Run detection signals from all installed domain packs
2. Rank by confidence (how many signals matched)
3. Present the recommendation to the user:
   ```
   Detected domain: software (go)
   Confidence: package.json, go.mod, .go files in tree
   
   Use this domain? (y/n/other):
   ```
4. User confirms, overrides, or specifies a different domain
5. `.rigor/config.yaml` is generated with the domain pack defaults

### Reviewer loading

Reviewers load by convention: the gate server scans
`skills/domain/<active-domain>/reviewers/` for SKILL.md files. The domain's
`defaults.yaml` declares which reviewers are required vs optional.

User config can override: add reviewers, remove reviewers, or change which
are required.

### Software domain pack example

```yaml
# skills/domain/software/defaults.yaml
detection:
  signals:
    - file_exists: ["package.json", "go.mod", "*.csproj", "pyproject.toml",
                     "Cargo.toml", "requirements.txt"]
    - dir_exists: ["src", "lib", "cmd", "internal"]

gates:
  gate_0:
    checks:
      - name: "tests"
        command: "${lang.test_command}"
        metric:
          parse: "${lang.coverage_pattern}"
          threshold: 85
          label: "coverage"
      - name: "lint"
        command: "${lang.lint_command}"

  gate_8:
    reviewers:
      - code-quality
      - security
      - logic
      - test-quality
    required_reviewers:
      - security
      - logic
    max_critical_findings: 0
    max_high_findings: 0

  gate_9:
    require_user_approval: true
```

The `${lang.*}` variables reference the active lang pack's commands. This
preserves the lang pack system within the software domain.

### Physics domain pack example

```yaml
# skills/domain/physics/defaults.yaml
detection:
  signals:
    - file_contains:
        pattern: ["numpy", "scipy", "matplotlib", "sympy"]
        in: ["*.py", "requirements.txt", "pyproject.toml"]
    - file_exists: ["*.ipynb", "simulation/", "data/"]

gates:
  gate_0:
    checks:
      - name: "simulation"
        command: "python run_simulation.py --validate"
        metric:
          parse: "convergence:\\s+(\\d+\\.?\\d*)"
          threshold: 0.95
          label: "convergence"
      - name: "equations"
        command: "python check_dimensions.py"
      - name: "build"
        command: "jupyter nbconvert --execute *.ipynb"

  gate_8:
    reviewers:
      - methodology
      - statistical-validity
      - reproducibility
    required_reviewers:
      - methodology
    max_critical_findings: 0
    max_high_findings: 0

  gate_9:
    require_user_approval: true
```

### Academic domain pack example

```yaml
# skills/domain/academic/defaults.yaml
detection:
  signals:
    - file_exists: ["*.tex", "*.bib", "paper/", "thesis/"]
    - file_contains:
        pattern: ["\\documentclass", "\\bibliography"]
        in: ["*.tex"]

gates:
  gate_0:
    checks:
      - name: "compile"
        command: "pdflatex -halt-on-error main.tex"
      - name: "citations"
        command: "bibtex main"
      - name: "spell-check"
        command: "aspell list < main.tex | wc -l"
        metric:
          parse: "(\\d+)"
          threshold: 0
          label: "misspellings"

  gate_8:
    reviewers:
      - methodology
      - literature-coverage
      - argument-structure
      - statistics
    required_reviewers:
      - methodology
      - argument-structure
```

## Components

| Component | Type | Change |
|-----------|------|--------|
| `src/config/schema.ts` | modify | Replace typed gate fields (`test_command`, `lint_command`, `coverage_threshold`) with generic `Check[]` array. Keep backward compat by mapping old fields to new format during config loading. |
| `src/gates/gate0.ts` | modify | Loop over `checks` array. For each: run command, check exit code, optionally parse metric and compare to threshold. |
| `src/gates/gate2-5.ts` | modify | Same generic check pattern. Frontend gates become checks in the software domain pack defaults, not hardcoded gates. |
| `src/config/loader.ts` | modify | Load domain pack `defaults.yaml`, merge with lang pack defaults, merge with user config. Resolve `${lang.*}` variables. |
| `skills/domain/software/` | new | Software domain pack: `DOMAIN.md`, `defaults.yaml`, existing reviewers moved here. |
| `skills/domain/physics/` | new (future) | Physics domain pack -- example, not built in Phase 1. |
| `skills/domain/academic/` | new (future) | Academic domain pack -- example, not built in Phase 1. |
| `skills/init/SKILL.md` | modify | Add domain detection and recommendation prompt. |
| `docs/architecture.md` | modify | Replace "dev cycle" with "project cycle". Document domain pack system. |
| `docs/gates.md` | modify | Generalize gate descriptions. Document generic check format. |
| `README.md` | modify | Update positioning from dev tool to project orchestrator. |

## Key Decisions

| Decision | Chosen | Rejected Alternative | Why |
|----------|--------|---------------------|-----|
| Gate check format | `{ name, command, metric? }` | Typed interfaces per domain | Command + exit code is the universal contract. Typed interfaces add coupling without value. |
| Domain pack format | YAML defaults + SKILL.md reviewers | TypeScript adapters with `detect()`/`check()` interfaces | No code needed per domain. Config + skills is sufficient because any validation can be a script with exit code 0/1. |
| Software as domain pack | First-class domain pack, not special-cased in the core | Keep software behavior hardcoded | Eating our own dog food proves the abstraction works. If software can't be expressed as a domain pack, the abstraction is wrong. |
| Lang packs relationship | Lang packs nest under software domain, provide `${lang.*}` variables | Lang packs become domain packs themselves | Lang packs serve a different purpose (tool-specific commands within one domain). They complement domain packs, not replace them. |
| Domain detection | Auto-detect with user confirmation/override prompt | User must declare domain manually | Auto-detect reduces friction. Override ensures user agency. Same pattern as lang pack detection today. |
| Reviewer loading | Convention-based directory scan with config override | Explicit registration in domain config | Convention reduces boilerplate. Config override preserves flexibility. |
| Gate numbering | Keep gate 0/8/9 as universal, domain defines middle gates | Let domains define all gate names | Gate 0 (quality checks), Gate 8 (review), Gate 9 (acceptance) are universal concepts. The middle gates are domain-specific but the bookends are structural. |
| Backward compatibility | Config loader maps old `test_command`/`lint_command` fields to new `checks` format | Breaking change | Existing users shouldn't need to rewrite config. Old format works, new format is available. |

## Open Questions

1. **Gate numbering for middle gates:** Should domains declare gates 1-7
   freely, or should there be a convention (e.g., gate 1 = infrastructure,
   gates 2-5 = domain-specific quality, gates 6-7 = reserved)?
2. **Cross-domain projects:** A project might be both software and physics
   (e.g., a simulation library). Should multiple domain packs compose, or
   should the user pick one primary domain?
3. **Domain pack distribution:** How do users install third-party domain
   packs? npm packages? git clone into `skills/domain/`? The installer
   already handles skill symlinks.

## Alternatives Considered

### Option 2: Gate Protocol with TypeScript Adapters

Define a gate interface with `detect()`, `check()`, `evidence()` methods.
Domain adapters implement the interface in TypeScript.

**Rejected because:** The universal contract (command + exit code + optional
metric) makes TypeScript adapters unnecessary. Any validation can be expressed
as a CLI command. Adding a TypeScript adapter layer creates coupling and
requires domain authors to write code instead of config.

### Option 3: Rigor Core + Domain SDKs (npm packages)

Split into `@rigor/core` and `@rigor/domain-*` npm packages with a plugin
registration API.

**Rejected because:** Premature. We have one domain today. Splitting into
packages and defining a registration API before proving the second domain
works is a classic over-engineering trap. Option 1 can evolve into Option 3
later if needed — the domain pack directory structure is compatible with
future extraction into packages.
