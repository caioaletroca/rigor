---
name: rigor:lint
description: >-
  Run lint and fix issues — detects language, runs the lang pack's lint command,
  fixes issues directly, verifies clean. No agent dispatch, just run and fix.
  Use after implementation, before review, or whenever lint is dirty.
  Skip when there are no source files to lint.
---

Run the project's linter, fix every issue it reports, and verify clean. This skill does not dispatch agents or perform AI-based lint checking -- it runs the lint command, fixes what it finds, and loops until clean or the iteration cap is reached.

**Announce at start:** "Using rigor:lint to run lint and fix issues."

---

## Step 0 -- Detect Language and Load Lang Pack

Inspect the project root for language markers. For each detected language, load the corresponding lang pack from `skills/lang/<language>/SKILL.md` (resolved relative to rigor's install path).

| Signal | Language | Lang Pack |
|--------|----------|-----------|
| `go.mod` | Go | `rigor:lang:go` |
| `package.json` with `typescript` in `devDependencies`, or `tsconfig.json` | TypeScript | `rigor:lang:ts` |
| `*.csproj` or `*.sln` | C# | `rigor:lang:csharp` |
| `pyproject.toml`, `setup.py`, `setup.cfg`, or `requirements.txt` | Python | `rigor:lang:py` |

Check `.rigor/config.yaml` for overrides. If it defines `lint_command` or `format_command`, those override the lang pack defaults (same precedence rules as the lang pack documents).

If multiple languages are detected, process each independently in sequence. Each language gets its own lint/fix/verify cycle.

If no lang pack matches, STOP. Report: "No lang pack found. Configure the language in `.rigor/config.yaml` or add a lang pack." Do NOT guess which linter to run.

### Extract Commands

From each loaded lang pack's **Gate 0: Implementation** section, extract:

| Purpose | Go | TypeScript | C# | Python |
|---------|-----|-----------|-----|--------|
| **Lint** | `golangci-lint run ./...` | `npx eslint .` | `dotnet format --verify-no-changes` | `ruff check .` |
| **Format** | (implicit in lint) | `npx prettier --check .` | (implicit in lint) | `ruff format --check .` |

Use EXACTLY the commands from the lang pack. If `.rigor/config.yaml` overrides a command, use the override instead.

---

## Step 1 -- Run Lint

Execute the lint command from the lang pack.

```bash
# Example for Go:
golangci-lint run ./... 2>&1
```

Capture ALL output. Do not truncate.

**If exit code is 0:** Report "Lint clean. No issues found." and STOP. Do not proceed to Step 2.

**If exit code is non-zero:** Parse the output. Extract each issue:
- **File** and **line number**
- **Rule** or error code
- **Message** describing the problem

Display a summary before fixing:

```
Lint Issues Found
-----------------
Language: Go
Linter:   golangci-lint
Issues:   12
```

---

## Step 2 -- Fix Issues

### 2.1 -- Try Auto-Fix First

If the linter supports a built-in auto-fix mode, run it first. This handles the bulk of mechanical fixes faster and more reliably than manual edits.

| Language | Auto-Fix Command | What It Fixes |
|----------|-----------------|---------------|
| Go | `golangci-lint run --fix ./...` | A subset of linters support `--fix` (e.g., `goimports`, `whitespace`) |
| TypeScript | `npx eslint --fix .` | Most style and import rules |
| C# | `dotnet format` | All formatting and some analyzer fixes |
| Python | `ruff check --fix .` | Most lint rules with safe auto-fixes |

### 2.2 -- Run Format (If Applicable)

If the lang pack defines a format command, run it in write mode (not check mode):

| Language | Format Command |
|----------|---------------|
| Go | (handled by `gofmt -w .` or via `golangci-lint --fix`) |
| TypeScript | `npx prettier --write .` |
| C# | (handled by `dotnet format`) |
| Python | `ruff format .` |

### 2.3 -- Fix Remaining Issues Manually

After auto-fix and format, re-run the lint command to see what remains. For each remaining issue:

1. Read the file at the reported line
2. Read enough surrounding context to understand the code (at least 10 lines above and below)
3. Understand what the lint rule requires
4. Apply the minimal fix that resolves the issue without changing behavior
5. Move to the next issue

**Fix discipline:**
- Fix ONLY the reported issue. Do not refactor surrounding code.
- If a fix requires understanding a type or function signature, read the relevant definition first.
- If a fix would change program behavior (not just style), flag it to the user instead of applying it silently.

---

## Step 3 -- Verify Clean

Re-run the lint command from Step 1 (same command, same flags).

**If exit code is 0:** Done. Report success.

**If exit code is non-zero:** Go back to Step 2.3 for the remaining issues. This is iteration 2.

### Iteration Cap

Maximum 3 iterations (Step 1 counts as iteration 1). If lint is still not clean after 3 rounds:

**STOP.** Report:
- How many issues were fixed across all iterations
- How many issues remain
- List each remaining issue (file, line, rule, message)

Do NOT continue looping. If 3 rounds did not clean it, the remaining issues likely need human judgment or a config change.

---

## Step 4 -- Report

After a clean lint or hitting the iteration cap, report the result:

```
Lint Result
-----------
Language:       Go
Linter:         golangci-lint
Status:         CLEAN | DIRTY (N remaining)
Issues fixed:   N
Iterations:     N/3
Auto-fixed:     N
Manual fixes:   N
```

If multiple languages were processed, report each separately.

---

## Anti-Patterns (FORBIDDEN)

- Do NOT dispatch agents or sub-agents -- this skill runs lint and fixes issues directly in the current session
- Do NOT skip the auto-fix step -- always try the linter's built-in fix before manual edits
- Do NOT use a different linter than what the lang pack specifies -- the lang pack is the source of truth
- Do NOT refactor code while fixing lint -- fix the lint issue only, minimal changes
- Do NOT disable lint rules or add suppression comments (e.g., `//nolint`, `// eslint-disable`, `# noqa`) to make issues go away -- fix the code
- Do NOT loop more than 3 iterations -- if lint is not clean after 3 rounds, report and stop
- Do NOT ignore the format step when the lang pack defines a format command
- Do NOT truncate lint output -- capture all issues to ensure nothing is missed

---

## Anti-Rationalization Table

| Rationalization | Why It Is WRONG | Required Action |
|-----------------|-----------------|-----------------|
| "This lint rule is wrong, I will disable it" | The lang pack or project config chose these rules. Disabling rules masks real issues and overrides the team's standards. | **MUST fix the code, not the rules. If truly wrong, tell the user -- do not suppress silently.** |
| "I will refactor this whole function while fixing lint" | Scope creep. A lint fix that changes behavior is a bug, not a fix. Mixing refactoring with lint fixing makes it impossible to verify the fix is safe. | **MUST fix the lint issue only. Minimal changes.** |
| "This is a false positive" | Check the lang pack's lint config first. If it is truly a false positive, tell the user and let them decide. Silent suppression hides the decision from the team. | **MUST report to the user. Do not add suppression comments without explicit approval.** |
| "I need a different linter" | The lang pack specifies the linter. Using a different tool means running unconfigured rules against code tuned for the specified linter. | **MUST use what the lang pack specifies. If it is missing, tell the user to configure it.** |
| "Lint is still dirty but I already fixed a lot, good enough" | The skill's contract is clean lint or 3 iterations. Stopping early because "most" issues are fixed leaves the codebase in a dirty state. | **MUST continue fixing until clean or iteration cap is reached.** |
| "I will add a nolint comment since I cannot figure out the fix" | Suppression is not a fix. It hides the issue from future runs and normalizes ignoring lint. | **MUST either fix the code or report the issue as unfixable. Never suppress.** |
| "Let me run lint on just the changed files to save time" | Fixes in one file can introduce issues in another (e.g., import changes). The linter must run on the full scope it was configured for. | **MUST run the lint command as specified in the lang pack, with its full scope.** |
