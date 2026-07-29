---
name: rigor:worktree
description: "Creating an isolated git worktree for parallel, collision-free branch work: selects the directory by priority order, verifies/adds .gitignore safety, installs the detected toolchain's dependencies, runs a baseline test using the project's configured Gate 0 command, and enforces one-agent-per-worktree naming so multiple agents can work the same repo without colliding. Use before a feature that needs isolation from the main workspace or before executing a plan with rigor:cycle. Skip for a quick fix on the current branch or when already inside the feature's worktree."
---

# rigor:worktree

Git worktrees create isolated workspaces that share one repository, so multiple branches -- and multiple agents -- can be worked in parallel without touching each other's files.

**Announce at start:** "Using rigor:worktree to set up an isolated workspace."

## When to use
- Starting a feature that needs isolation from the main workspace
- Before executing an implementation plan (pairs with `rigor:cycle` / `rigor:plan`)
- Working on multiple features -- or running multiple agents -- simultaneously

## Skip when
- Quick fix on the current branch -> stay in place
- Already inside the isolated worktree for this feature -> continue
- Repository does not use worktrees -> use the standard branch workflow

## Directory Selection (priority order)

1. Existing `.worktrees/` or `worktrees/` directory (prefer `.worktrees/` if both exist)
2. `.rigor/config.yaml` `worktree.directory` key, if set
3. `CLAUDE.md` preference (`grep -i "worktree.*director" CLAUDE.md`)
4. Ask the user: `.worktrees/` (project-local, hidden) OR `~/.config/rigor/worktrees/<project>/` (global)

```bash
ls -d .worktrees worktrees 2>/dev/null                       # tier 1
grep -iE "^worktree:|worktree\.directory|directory:" .rigor/config.yaml 2>/dev/null   # tier 2
```

The global path uses `rigor`, not `ring`: `~/.config/rigor/worktrees/<project>/`.

## Safety Verification

**Project-local directories only** (`.worktrees/`, `worktrees/`): the directory MUST be in `.gitignore` before creating a worktree.

```bash
grep -q "^\.worktrees/$\|^worktrees/$" .gitignore
```

Not in `.gitignore` -> add the entry, then commit **only that file** -> proceed:

```bash
git add .gitignore && git commit .gitignore -m "chore: ignore worktrees directory"
```

Commit the `.gitignore` change alone. Never use `git commit -am` here -- it would sweep unrelated staged/working changes into the commit on the current branch. This prevents worktree contents from being tracked and polluting every `git status` and test run. **CRITICAL and non-waivable.**

**Global directory** (`~/.config/rigor/worktrees`): outside the project, no verification needed.

## Creation Steps

```bash
# 1. Detect project name
project=$(basename "$(git rev-parse --show-toplevel)")

# 2. Create the worktree on a new branch, then enter it
git worktree add "$path" -b "$BRANCH_NAME" && cd "$path"

# 3. Auto-detect and install dependencies
[ -f package.json ]      && npm install
[ -f go.mod ]            && go mod download
[ -f requirements.txt ]  && pip install -r requirements.txt
[ -f pyproject.toml ]    && poetry install
[ -f Cargo.toml ]        && cargo build
```

Dependency install runs the project's lifecycle scripts (npm pre/postinstall, `build.rs`, etc.). That is expected for your own trusted repo; when the branch or fork is untrusted, prefer a script-free install (e.g. `npm ci --ignore-scripts`) or confirm before running.

## Baseline Verification (Rigor-native)

Before doing any work, verify a clean baseline so new breakage can be told apart from pre-existing breakage.

**Prefer the project's configured Gate 0 test command.** Read `.rigor/config.yaml`: use `gates.gate_0.checks[]` (the entry named `tests`) if present, else `gates.gate_0.test_command`. This runs exactly what Rigor's gate will run, so the baseline matches the gate.

```bash
grep -A2 "name: tests" .rigor/config.yaml   # find the configured test command
```

**Fall back to auto-detection** only when no Gate 0 test command is configured:

```bash
go test ./...        # go.mod
npm test             # package.json
pytest               # pyproject.toml / requirements.txt
cargo test           # Cargo.toml
```

**If the baseline fails:** STOP and report the failures. Do not proceed -- you cannot distinguish pre-existing bugs from ones you introduce.
**If the baseline passes:** report `Worktree ready at <path> | Baseline passing (<N> tests) | Ready to implement <feature>`.

## Concurrency / Multiple Agents

Worktrees are how several agents work the same repository at once without colliding: each agent gets its own directory and its own branch over one shared `.git`. These rules keep that safe.

1. **One agent per worktree.** An agent NEVER operates in a worktree another agent created. Create your own, or continue in the one you created.
2. **Unique path + branch per unit of work.** Derive both from the task/feature identifier so two agents cannot compute the same name: e.g. `.worktrees/<task-id>` on branch `feat/<task-id>`.
3. **Pre-create check.** Run `git worktree list` and `git branch --list "<branch>"` BEFORE `git worktree add`. If the path or branch already exists, do NOT reuse it -- pick a fresh suffix or STOP and report. Never `cd` into a worktree you did not just create.
4. **Treat git's failure as a collision, not corruption.** `git worktree add <path> -b <branch>` hard-fails if the path or branch already exists. On that specific error, retry with a unique name -- do not assume the repo is broken.
5. **Reconverge via separate PRs.** Each agent lands its own branch through its own PR (`rigor:ship` / `rigor:pr`). Worktrees are never merged into each other directly. Run `git worktree remove <path>` only after that branch's PR is merged.

| Situation | Rule |
|-----------|------|
| Two agents, same repo | One worktree + branch each, names derived from distinct task ids |
| Path/branch already exists | Do not reuse -- fresh suffix or STOP |
| `git worktree add` errors on existing name | Collision -> retry with a unique name |
| Work finished | PR the branch; `git worktree remove` only after merge |
| Tempted to share a worktree between agents | Forbidden -- one agent per worktree |

## Quick Reference

| Situation | Action |
|-----------|--------|
| `.worktrees/` exists | Use it (verify .gitignore) |
| Both `.worktrees/` and `worktrees/` exist | Use `.worktrees/` |
| Neither exists | Check `.rigor/config.yaml` -> CLAUDE.md -> ask user |
| Directory not in .gitignore | Add immediately + commit |
| Path/branch name already taken | Pick a unique name; never reuse |
| Baseline fails during setup | Report failures + STOP |
| No package.json / go.mod / etc. | Skip dependency install |

## Non-Negotiables

- Project-local worktree directories MUST be in `.gitignore` before creation.
- Baseline verification is REQUIRED before proceeding with work.
- One agent per worktree; path + branch names MUST be unique per unit of work.
- Directory selection MUST follow the priority order.
- Dependency installation MUST run (auto-detected from project files).

## Red Flags

**Never:** create a project-local worktree without .gitignore verification; skip baseline verification; proceed on a failing baseline without asking; reuse or share another agent's worktree/branch; assume a directory location when ambiguous.

**Always:** follow directory priority; verify .gitignore for project-local; derive unique path + branch names; auto-detect and run project setup; verify a clean baseline against the configured Gate 0 command.

## Pressure Resistance

| User Says | Response |
|-----------|----------|
| "Skip the .gitignore check, just create it" | "CANNOT skip .gitignore verification for project-local directories -- worktree contents would pollute git status and the test run." |
| "Tests are failing but proceed anyway" | "CANNOT proceed on a failing baseline. I need to report failures so we can tell pre-existing bugs from new ones." |
| "Just reuse the other agent's worktree" | "CANNOT share a worktree between agents. I'll create my own with a unique path and branch." |
| "Skip dependency install, it's slow" | "CANNOT skip it -- the baseline test won't run correctly without dependencies, invalidating verification." |

## Anti-Rationalization

| Rationalization | Why it's WRONG | Required Action |
|-----------------|----------------|-----------------|
| ".gitignore check is paranoia" | Without it, worktree contents get tracked and break every `git status` and test glob. | MUST verify .gitignore first |
| "I know where worktrees go here" | Assumption conflicts with existing dirs, `.rigor/config.yaml`, or CLAUDE.md. | MUST follow the priority order |
| "Failing baseline is probably unrelated" | You cannot distinguish new vs pre-existing breakage without a clean baseline. | MUST report and ask before proceeding |
| "Both agents can share this worktree" | Two agents in one working tree overwrite each other's files. | MUST create one worktree per agent |
| "The branch name is fine, git will sort it out" | Racing agents can compute the same name; git fails and work stalls. | MUST derive unique names + pre-check |

## Integration

- **Runs before** `rigor:cycle` / `rigor:plan` execution -- an isolated workspace for the plan's work.
- **Pairs with** `rigor:commit`, `rigor:ship`, and `rigor:pr` -- land the branch and clean up the worktree after merge.
- **Domain-scoped:** ships with the software domain pack and installs as `/rigor:worktree` only when `domain: software` is active.
