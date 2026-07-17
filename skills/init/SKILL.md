---
name: rigor:init
description: >-
  Project onboarding — detects the project's tech stack and creates or
  audits .rigor/config.yaml with the correct gate commands. Sweep mode
  scans for language markers, test frameworks, and linters. Apply mode
  writes a working config file. Use when setting up Rigor on a new
  project or auditing an existing config. Skip when config is already
  validated and working.
---

Onboard any project onto Rigor in one pass. Detects the stack, validates or creates configuration, and verifies gate commands work. Operates in two modes: Sweep (read-only audit of existing config) and Apply (writes config).

**Announce at start:** "Using rigor:init to onboard this project."

---

## HARD STOP -- DETECT BEFORE WRITING

Never guess the tech stack. Always detect it from real project files. Wrong gate commands waste every cycle -- a misconfigured `test_command` means Gate 0 fails on every task, a wrong `lint_command` means every check is noise.

Do NOT:
- Assume the language from the repo name
- Copy config from a different project
- Ask the user what stack they use when the files are right there

DO:
- Read the actual files in the project root
- Stop at the first confident match per category
- Report what you found before writing anything

---

## Step 1 -- Stack Detection

Scan the project root for these signals. Check in order, stop at first match per category.

### Language

| Signal | Language | Confidence |
|--------|----------|------------|
| `go.mod` | Go | high |
| `tsconfig.json` | TypeScript | high |
| `package.json` with `typescript` in deps | TypeScript | high |
| `package.json` without `typescript` | JavaScript | medium |
| `*.csproj` or `*.sln` | C# | high |
| `pyproject.toml` or `requirements.txt` | Python | high |
| `Cargo.toml` | Rust | high |

### Test Framework

| Signal | Framework |
|--------|-----------|
| `vitest` in package.json deps | Vitest |
| `jest` in package.json deps | Jest |
| `go test` (any Go project) | Go test |
| `xunit` or `nunit` in `*.csproj` deps | xUnit / NUnit |
| `MSTest` in `*.csproj` deps | MSTest |
| `pytest` in requirements | Pytest |
| `cargo test` (any Rust project) | Cargo test |

### Linter

| Signal | Linter |
|--------|--------|
| `.golangci.yml` or `.golangci.yaml` | golangci-lint |
| `eslint` in package.json deps | ESLint |
| `@biomejs/biome` in package.json deps | Biome |
| `biome.json` or `biome.jsonc` | Biome |
| `.editorconfig` with C# project | dotnet format |
| `ruff` in pyproject.toml | Ruff |

### Package Manager

| Signal | Manager |
|--------|---------|
| `pnpm-lock.yaml` | pnpm |
| `yarn.lock` | yarn |
| `bun.lockb` | bun |
| `package-lock.json` | npm |
| `go.sum` | go modules |
| `*.csproj` (NuGet) | dotnet restore |

### Output

After detection, report the results before proceeding:

```
Stack Detection:
  Language:        TypeScript (high) -- tsconfig.json found
  Test Framework:  Vitest -- vitest in devDependencies
  Linter:          ESLint -- eslint in devDependencies
  Package Manager: pnpm -- pnpm-lock.yaml found
```

If a category has no match, report it as "not detected" and note what was checked.

---

## Step 2 -- Sweep Mode (Audit)

If `.rigor/config.yaml` already exists, audit it against the detected stack.

### 2.1 -- Read and Parse

Read `.rigor/config.yaml`. If the file is malformed YAML, STOP and report the parse error. Do not attempt to fix malformed YAML automatically.

### 2.2 -- Validate Gate Commands

Check each gate command against the detected stack:

| Check | Pass Condition |
|-------|---------------|
| `test_command` matches detected test framework | Command references the correct runner (e.g., `vitest` for Vitest projects, `go test` for Go) |
| `lint_command` matches detected linter | Command references the correct linter (e.g., `eslint` for ESLint, `golangci-lint` for Go) |
| `coverage_threshold` is reasonable | Value is between 1 and 100 |

### 2.3 -- Check for Common Misconfigurations

| Misconfiguration | Condition | Severity |
|-----------------|-----------|----------|
| Missing test command | `test_command` is empty or absent AND test files exist in the project | warning |
| Missing lint command | `lint_command` is empty or absent AND a linter config file exists | warning |
| Suspiciously low coverage | `coverage_threshold` below 50 | warning |
| Unrealistic coverage | `coverage_threshold` at 100 | warning |
| Wrong test runner | `test_command` references a framework not detected in the project | error |
| Wrong linter | `lint_command` references a linter not detected in the project | error |

### 2.4 -- Report

Present findings as a table:

```
| Setting            | Current Value                  | Recommended                    | Status  |
|--------------------|--------------------------------|--------------------------------|---------|
| test_command       | "npx vitest run --coverage"    | "npx vitest run --coverage"    | OK      |
| lint_command       | ""                             | "npx eslint ."                 | MISSING |
| coverage_threshold | 85                             | 85                             | OK      |
| require_test_files | true                           | true                           | OK      |
```

If `.rigor/config.yaml` does not exist, report: "No config file found -- run Apply mode to create one." Then proceed to Step 3.

---

## Step 3 -- Apply Mode (Create/Update Config)

Generate `.rigor/config.yaml` from the detected stack. Only write fields that differ from defaults. If a value matches the default, omit it -- this keeps the file minimal and makes upgrades easier.

### Defaults (from config.example.yaml)

| Field | Default |
|-------|---------|
| `coverage_threshold` | 85 |
| `lint_command` | `""` |
| `test_command` | `""` |
| `require_test_files` | true |

Since `lint_command` and `test_command` default to empty, you always need to write them when a linter or test framework is detected. Since `coverage_threshold` defaults to 85, omit it unless the project needs a different value. Since `require_test_files` defaults to true, omit it.

### Templates by Stack

**Go:**

```yaml
gates:
  gate_0:
    test_command: "go test -coverprofile=coverage.out -race ./..."
    lint_command: "golangci-lint run ./..."
```

**TypeScript (Vitest):**

```yaml
gates:
  gate_0:
    test_command: "npx vitest run --coverage"
    lint_command: "npx eslint ."
```

**TypeScript (Jest):**

```yaml
gates:
  gate_0:
    test_command: "npx jest --coverage"
    lint_command: "npx eslint ."
```

**TypeScript (Biome instead of ESLint):**

Replace the lint command:

```yaml
gates:
  gate_0:
    lint_command: "npx biome check ."
```

**Python:**

```yaml
gates:
  gate_0:
    test_command: "pytest --cov=src --cov-report=term"
    lint_command: "ruff check ."
```

**Rust:**

```yaml
gates:
  gate_0:
    test_command: "cargo test"
    lint_command: "cargo clippy -- -D warnings"
```

### Writing the File

1. Create the `.rigor/` directory if it does not exist.
2. If `.rigor/config.yaml` already exists and Sweep found issues, update only the misconfigured fields. Preserve all other existing configuration (commit settings, ship settings, gate_8, gate_9).
3. If `.rigor/config.yaml` does not exist, write a new file with only the gate_0 section.
4. Do NOT overwrite existing correct values.
5. Do NOT add commented-out examples or explanatory comments -- the config.example.yaml in rigor's install directory serves that purpose.

---

## Step 4 -- Verification

After creating or updating config, verify each command actually works on this machine.

### 4.1 -- Run Each Command

For each configured command, run it and check the result:

```bash
# Test command
<test_command>

# Lint command
<lint_command>
```

A command "works" if the executable is found. The command is allowed to exit non-zero (tests may fail, linter may find issues) -- what matters is that the binary exists and runs.

A command "fails verification" if:
- Exit code is 127 (command not found)
- stderr contains "not found", "not recognized", or "No such file"

### 4.2 -- Report Results

```
Verification:
  test_command: go test -coverprofile=coverage.out -race ./... -> command found
  lint_command: golangci-lint run ./... -> command found
  Gate 0 is ready.
```

If a command fails verification, suggest the install command:

```
Verification:
  test_command: npx vitest run --coverage -> command found
  lint_command: npx eslint . -> NOT FOUND
    Install with: npm install --save-dev eslint
  Gate 0 is NOT ready -- fix the issues above first.
```

---

## Anti-Patterns

| Do NOT | Why |
|--------|-----|
| Guess the language without checking files | Wrong commands waste every gate check |
| Set `coverage_threshold` to 100 | No project sustains 100%; this blocks all progress |
| Copy another project's config blindly | Different stacks need different commands |
| Skip verification | A typo in `test_command` means Gate 0 always fails |
| Write config fields that match defaults | Bloats the file; makes upgrades harder |
| Add comments or examples to the config | That is what config.example.yaml is for |
| Overwrite existing correct gate_8/gate_9 settings | Init only owns gate_0; preserve everything else |

---

## Lang Pack Cross-Reference

After init, load the appropriate lang pack for Gate 8 review patterns:

| Language | Lang Pack | Status |
|----------|-----------|--------|
| Go | `rigor:lang:go` | available |
| TypeScript | `rigor:lang:ts` | available |
| C# | `rigor:lang:csharp` | available |
| Python | -- | not yet available |
| Rust | -- | not yet available |

The lang pack is not required for init to succeed. It provides Gate 8 review patterns that become relevant when the cycle reaches the review phase.
