---
name: rigor:ship
description: >-
  End-to-end git orchestrator: branch, commit, push, PR, with a full plan
  presented before any execution. Detects base branch and scope allowlist once
  and propagates to all phases. Use when ready to ship a complete unit of work.
  Skip if only one phase is needed: commit-only use rigor:commit,
  PR-only use rigor:pr.
---

End-to-end shipping workflow: detect base branch and scope policy once, present a complete plan, then execute branch, commit, push, and PR in sequence, confirming at each phase. Uses `rigor:commit` and `rigor:pr` internally -- their rules and anti-patterns apply in full.

Configuration is read from `.rigor/config.yaml`. If no config file exists, defaults apply (see `rigor:commit` for config schema).

---

## HARD STOP -- PRESENT PLAN BEFORE EXECUTING ANY MUTATING COMMAND

Read-only discovery commands (`git fetch`, `git ls-remote`, `git status`, `git diff`, `git log`) are allowed before approval -- they are needed to build the plan.

MUST complete Phase 0 detection, analyze the current state, and present a complete plan to the user before running any **mutating** `git` or `gh` command (`git checkout -b`, `git add`, `git commit`, `git push`, `gh pr create`). Executing mutating commands without approval is FORBIDDEN.

---

## Phase 0 -- Detect Base Branch, Scope Policy, and Config

MUST complete all detections before analyzing changes or drafting anything. These values are resolved once and propagated to all subsequent phases.

### 0A -- Load Config

Read `.rigor/config.yaml` from the repository root. Extract all settings relevant to commit and ship behavior:

| Key | Default | Used In |
|-----|---------|---------|
| `commit.gpg_sign` | `false` | Phase 2 (commit signing) |
| `commit.trailers` | `[]` | Phase 2 (trailer flags) |
| `commit.types` | all standard | Phase 2 (type validation) |
| `commit.require_scope` | `true` | Phase 0B, Phase 2 |
| `ship.branch_pattern` | `<type>/<description>` | Phase 1 (branch naming) |
| `ship.force_push` | `"never"` | Phase 3 (push policy) |

If the file does not exist, use all defaults. Do NOT prompt the user to create one.

### 0B -- Detect Base Branch

```bash
# Probe A -- GitHub API default (fallback: git remote show origin | grep 'HEAD branch' | awk '{print $NF}')
gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'

# Probe B -- PR template hint: read .github/pull_request_template.md for explicit branch name

# Probe C -- develop existence
git ls-remote --heads origin develop
```

Apply precedence in order -- first match wins:

| Priority | Source | Rule |
|----------|--------|------|
| **1 -- highest** | PR template | Explicit branch name in `.github/pull_request_template.md` -- overrides everything |
| **2** | develop + user | Probe C finds `develop` AND differs from Probe A -- confirm with user which target |
| **3 -- fallback** | GitHub API | Use value from Probe A |
| **4** | Neither | STOP -- confirm with the user |

**Why not develop-first:** a repo may have a stale `develop` branch while the real PR target is `main`. The GitHub API is the authoritative source; `develop` existence triggers a confirmation step instead of a silent assumption.

### 0C -- Detect Scope Policy

Check in this order:

1. `.github/workflows/pr-validation.yml` (primary)
2. `.github/workflows/pr-title.yml`
3. `.github/workflows/commitlint.yml`
4. `.github/workflows/semantic-pull-request.yml`
5. Root configs: `commitlint.config.{js,cjs,mjs,ts}`, `.commitlintrc*`

Extract the allowed `scope` list and any `type` restrictions.

| Situation | Required Action |
|-----------|-----------------|
| Policy found, scope is clear | Use only scopes from the allowlist |
| Policy found, scope is ambiguous | STOP and confirm with the user which allowed scope to use |
| No policy file found, `require_scope` is `true` | MUST still include a scope -- confirm with the user what scope to use |
| No policy file found, `require_scope` is `false` | Scope is optional |

---

## Phase 0D -- Analyze Current State

```bash
git status
git branch
git diff
git log --oneline -5
```

Use this output for the plan.

---

## Phase 0E -- Present Full Plan for Approval

Present everything before touching git:

```
Shipping Plan -- waiting for your approval
-------------------------------------------
Base branch:    develop   (from: git ls-remote)
Scope policy:   .github/workflows/pr-validation.yml -> scopes: [api, auth, docs, ci]
Chosen scope:   auth
Config:         .rigor/config.yaml (gpg_sign: true, trailers: 1 configured)

Phase 1 -- Branch
  Current branch: main -> will create: feat/add-oauth2-refresh
  Command: git checkout -b feat/add-oauth2-refresh origin/develop

Phase 2 -- Commit (via rigor:commit)
  Files to stage:
    - src/auth/oauth.ts (modified)
    - src/auth/oauth.test.ts (modified)
    - docs/auth/oauth-setup.md (modified)
  Proposed commits:
    1. feat(auth): add OAuth2 refresh token support
    2. docs(docs): update OAuth2 setup guide

Phase 3 -- Push
  Command: git push -u origin feat/add-oauth2-refresh

Phase 4 -- Pull Request (via rigor:pr)
  Title:   feat(auth): add OAuth2 refresh token support
  Base:    develop
  Command: gh pr create --title "..." --body "..." --base develop

Approve and execute? [Yes / Modify / Cancel]
```

MUST wait for explicit user approval. Do NOT begin Phase 1 until approved.

---

## Phase 1 -- Branch

### 1.1 -- Check Current Branch

If already on a feature branch (not `$BASE`, not `main` when `$BASE=develop`), confirm with the user:
- Use current branch, or
- Create a new branch from `origin/$BASE`

### 1.2 -- Create Branch (if needed)

Branch naming follows the config's `ship.branch_pattern` (default: `<type>/<description>` in kebab-case).

```bash
git fetch origin --quiet
# Check for duplicate
git ls-remote --heads origin <type>/<description>

# If no duplicate:
git checkout -b <type>/<description> origin/$BASE
```

If a branch with the same name already exists on remote, confirm with the user for a different name.

Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `perf` (or as restricted by config `commit.types`)

---

## Phase 2 -- Commit

Delegate to `rigor:commit` with the resolved `$BASE` and scope policy as context.

**MUST propagate `$BASE`** to `rigor:commit` -- Step 7 of that skill uses `origin/$BASE..HEAD` for commit batch scoping. Without it, the skill falls back to `@{u}` or re-detects the base, which works but is redundant when `$BASE` is already known here.

The following rules from `rigor:commit` apply in full:
- `$BASE` is already resolved -- pass it explicitly so Step 7 skips re-detection
- Scope MUST come from the allowlist resolved in Phase 0C (subject to `require_scope` setting)
- Commits MUST be atomic and logically grouped
- Trailers via `--trailer` flags, NEVER inside `-m` (only if trailers are configured)
- GPG sign with `-S` only if `gpg_sign: true` in config (no fallback if enabled -- if no key, stop and instruct user)
- All anti-patterns and anti-rationalization rules from `rigor:commit` are inherited

---

## Phase 3 -- Push

```bash
git push -u origin <current-branch>
```

Show the user:
- Branch name
- Number of commits being pushed
- Short summary of those commits

Confirm success before proceeding to Phase 4.

### Force Push Policy

The `ship.force_push` config controls behavior:

| Value | Behavior |
|-------|----------|
| `"never"` (default) | REFUSE `--force` or `--force-with-lease` under all circumstances |
| `"ask"` | If the user requests force push, confirm with a warning before proceeding |
| `"allow"` | Allow force push when explicitly requested by the user |

Even with `"allow"`, NEVER force push unless the user explicitly requests it. The policy only controls whether the request is honored.

---

## Phase 4 -- Pull Request

Delegate to `rigor:pr` with the resolved `$BASE` and scope policy as context.

The following rules apply:
- PR title MUST carry `type(scope): description` with scope from allowlist (when `require_scope` is true)
- Body MUST fill the repo's PR template if one exists
- MUST verify base branch after PR creation
- MUST retarget with `gh pr edit <number> --base $BASE` if base is wrong
- MUST return PR URL after confirmed success

---

## Arguments

If an argument is provided (e.g., `/rigor:ship feat/add-oauth2`), parse it as `<type>/<description>` for the branch name and skip the branch-naming question.

---

## Anti-Patterns (FORBIDDEN)

- Do NOT execute any `git` or `gh` mutating command before presenting the plan and getting approval
- Do NOT hardcode `--base develop` or `--base main` -- always use `$BASE` resolved in Phase 0B
- Do NOT skip Phase 0C scope detection -- missing scope breaks PR validation (when `require_scope` is true)
- Do NOT omit scope in commit messages or PR title (when `require_scope` is true)
- Do NOT invent scopes not in the allowlist -- confirm with the user if unclear
- Do NOT use `--force` on push unless the force push policy allows it AND the user explicitly asks
- Do NOT skip the post-PR-create base verification (delegated to `rigor:pr`)
- Do NOT proceed to the next phase if the current phase fails -- stop and confirm with the user
- Do NOT add `-S` to commits when `gpg_sign` is not enabled in config
- Do NOT omit `-S` from commits when `gpg_sign` IS enabled in config
- Do NOT skip configured trailers on any commit

---

## Anti-Rationalization Table

| Rationalization | Why It Is WRONG | Required Action |
|-----------------|-----------------|-----------------|
| "I know the base branch, I can skip detection" | Any repo can change. Detection takes 2 seconds and prevents irreversible mistakes. | **MUST detect with `git ls-remote`** |
| "I will present the plan after I start" | The plan exists so the user can catch mistakes before they happen. | **MUST present plan BEFORE any execution** |
| "Scope detection is only for PRs" | Commit messages also need the allowlist scope -- they are validated together. | **MUST detect scope before Phase 2** |
| "The user approved the plan, I can skip confirmations per phase" | Phases can fail independently. Each phase confirms its own success. | **MUST confirm success at each phase** |
| "I will use the same scope as last time" | Each repo may have a different allowlist. Re-detect for every invocation. | **MUST detect scope from the current repo** |
| "Branch creation failed but I will continue" | Subsequent phases depend on the branch existing. | **MUST stop and confirm with user on any failure** |
| "Force push is fine since it is a feature branch" | Force push policy is governed by config. Default is `"never"`. Only honor when policy allows AND user explicitly requests. | **MUST respect force_push config setting** |
| "No config file means I can choose freely" | No config means defaults apply. Defaults are documented and deterministic. | **Proceed with defaults, inform user** |
| "GPG signing failed so I will drop -S" | If `gpg_sign: true` in config, signing is mandatory. Stop and instruct user to fix GPG or disable in config. | **MUST stop on GPG failure when signing is enabled** |
| "This commit does not need the configured trailers" | Configured trailers apply to ALL commits unconditionally. | **MUST include all configured trailers** |
| "I will add -S even though config does not enable it" | Respect the config. Adding flags not specified in config introduces unexpected behavior. | **Only use `-S` when `gpg_sign: true` in config** |
