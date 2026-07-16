---
name: rigor:pr
description: >-
  Open a GitHub Pull Request with automatic base branch detection (3 probes),
  scope allowlist enforcement, PR template filling, precondition verification,
  and post-create base branch verification with retargeting. Use when the
  branch is pushed and the user wants to open a PR. Skip when working tree is
  dirty or branch has not been pushed -- tell the user to use rigor:commit
  first.
---

Open a GitHub Pull Request: detect base branch, enforce scope policy, verify preconditions, fill the PR template, draft the title and body, confirm with the user, create the PR, verify the base branch post-creation, and return the PR URL.

Configuration is read from `.rigor/config.yaml`. If no config file exists, defaults apply: scope required, all standard conventional commit types allowed.

---

## HARD STOP -- READ SCOPE POLICY AND CONFIG BEFORE ANYTHING ELSE

**The scope is REQUIRED in the PR title by default. It MUST come from the repo's allowlist.**

MUST detect the allowlist in Step 2 before drafting any PR title. A PR with an invented or omitted scope will fail PR validation.

MUST read `.rigor/config.yaml` in Step 2 to determine whether scope is required. When `commit.require_scope` is `false`, scope is optional in the PR title too.

---

## Step 1 -- Detect Base Branch

Three probes, applied in precedence order -- first match wins.

```bash
# Probe A -- GitHub API default (fallback: git remote show origin | grep 'HEAD branch' | awk '{print $NF}')
gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'

# Probe B -- PR template hint: read .github/pull_request_template.md for explicit branch name

# Probe C -- develop existence
git ls-remote --heads origin develop
```

| Priority | Source | Rule |
|----------|--------|------|
| **1 -- highest** | PR template | Explicit branch name in `.github/pull_request_template.md` -- overrides everything |
| **2** | develop + user | Probe C finds `develop` AND differs from Probe A -- confirm with user which target |
| **3 -- fallback** | GitHub API | Use value from Probe A |
| **4** | Neither | STOP -- confirm with the user |

**Why not develop-first:** a repo may have a stale `develop` branch while the real PR target is `main`. The GitHub API is the authoritative source; `develop` existence triggers a confirmation step instead of a silent assumption.

Store the result as `$BASE`. This value is used in Step 8 (create) and Step 9 (verify).

---

## Step 2 -- Detect Scope Policy and Load Config

### 2.1 -- Load Rigor Config

Read `.rigor/config.yaml` from the repository root. Extract:

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `commit.require_scope` | boolean | `true` | Whether scope is mandatory in the PR title |
| `commit.types` | list of strings | all standard types | Restricts allowed conventional commit types in the PR title |

If the file does not exist, use all defaults. Do NOT prompt the user to create a config file -- just proceed with defaults.

### 2.2 -- Locate the Scope Policy File

Check in this order:

1. `.github/workflows/pr-validation.yml` (primary)
2. `.github/workflows/pr-title.yml`
3. `.github/workflows/commitlint.yml`
4. `.github/workflows/semantic-pull-request.yml`
5. Root configs: `commitlint.config.{js,cjs,mjs,ts}`, `.commitlintrc*`

### 2.3 -- Extract the Allowed Scope List

Common forms to look for:

| Form | Example |
|------|---------|
| `scopes:` block (one per line) | Under `amannn/action-semantic-pull-request` |
| `scopes: a,b,c` inline | Comma-separated on one line |
| `scope-enum` rule | In commitlint config arrays |

Also note any **type** restrictions. If the config also specifies `commit.types`, the intersection of both constraints applies.

### 2.4 -- Apply the Policy

| Situation | Required Action |
|-----------|-----------------|
| Policy found, scope is clear | Use only scopes from the allowlist |
| Policy found, scope is ambiguous | STOP and confirm with the user which allowed scope to use |
| No policy file found, `require_scope` is `true` | MUST still include a scope -- confirm with the user what scope to use |
| No policy file found, `require_scope` is `false` | Scope is optional -- include one if it adds clarity, omit if not |

When `require_scope` is `true` (the default): **NEVER** omit the scope. **NEVER** invent a scope not in the allowlist.

State the policy source and chosen scope to the user before proceeding.

---

## Step 3 -- Verify Preconditions

All three checks MUST pass before proceeding. If any fails, STOP and tell the user.

### 3.1 -- Clean Working Tree

```bash
git status --porcelain
```

If output is non-empty, STOP. Tell the user to commit or stash changes first. Suggest `rigor:commit` for committing.

### 3.2 -- Branch Pushed to Remote

```bash
git ls-remote --heads origin "$(git branch --show-current)"
```

If the branch does not exist on the remote, STOP. Tell the user to push first:

```bash
git push -u origin "$(git branch --show-current)"
```

### 3.3 -- No Local Commits Ahead of Remote

```bash
git rev-list --count @{u}..HEAD
```

If the count is greater than 0, STOP. Tell the user to push the remaining commits before opening the PR.

---

## Step 4 -- Read PR Template

```bash
# Check for PR template
cat .github/pull_request_template.md 2>/dev/null \
  || cat .github/PULL_REQUEST_TEMPLATE.md 2>/dev/null \
  || cat docs/pull_request_template.md 2>/dev/null \
  || echo "NO_TEMPLATE"
```

If a template exists, the PR body MUST fill it in -- do NOT discard the template structure. Every section heading in the template MUST appear in the final body.

If no template exists, use a clean summary format.

---

## Step 5 -- Gather Diff Context

```bash
# All commits on this branch relative to the base
git log --oneline "origin/$BASE..HEAD"

# Full diff for body drafting
git diff "origin/$BASE..HEAD" --stat
git diff "origin/$BASE..HEAD"
```

Use this to understand the full scope of changes for the PR title and body.

---

## Step 6 -- Draft PR Title and Body

### PR Title Format

```
<type>(<scope>): <description>
```

- **Type**: from the allowed types list (default: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `style`, `perf`, `ci`, `build`)
- **Scope**: from the allowlist resolved in Step 2 (REQUIRED when `require_scope` is `true`)
- **Description**: imperative mood, lowercase, no period, max 50 characters after the prefix

When `require_scope` is `false` and no scope adds clarity, the title format is:

```
<type>: <description>
```

### PR Body

If a template exists (Step 4), fill every section. If no template, use a clean format:

- Summary of what the PR does and why
- List of notable changes
- Testing notes if applicable

Do NOT include AI attribution lines.

---

## Step 7 -- Show Full Draft for Approval

Present the complete draft to the user before creating anything:

```
Pull Request Draft -- waiting for your approval
-------------------------------------------------
Base branch: develop   (from: GitHub API)
Scope:       auth      (from: .github/workflows/pr-validation.yml)

Title: feat(auth): add OAuth2 refresh token support

Body:
  [full body content here]

Command that will run:
  gh pr create --title "feat(auth): add OAuth2 refresh token support" \
    --body "..." --base develop

Approve? [Create PR / Edit / Cancel]
```

MUST wait for explicit user approval. Do NOT create the PR until approved.

---

## Step 8 -- Create the PR

```bash
gh pr create \
  --title "<type>(<scope>): <description>" \
  --body "<body>" \
  --base "$BASE"
```

Capture the PR URL from the output. If the command fails, show the error and STOP.

---

## Step 9 -- Verify Base Branch Post-Creation

**This step is CRITICAL. Do NOT skip it.**

After the PR is created, verify the base branch is correct:

```bash
# Get the PR number from the URL
PR_NUMBER=$(echo "$PR_URL" | grep -oE '[0-9]+$')

# Check the actual base branch
gh pr view "$PR_NUMBER" --json baseRefName --jq '.baseRefName'
```

Compare the actual base with `$BASE`:

| Actual Base | Expected `$BASE` | Action |
|-------------|-------------------|--------|
| Matches | -- | Proceed to Step 10 |
| Does NOT match | -- | Retarget immediately |

### Retarget if Wrong

```bash
gh pr edit "$PR_NUMBER" --base "$BASE"
```

Verify again after retargeting:

```bash
gh pr view "$PR_NUMBER" --json baseRefName --jq '.baseRefName'
```

If the base is STILL wrong after retargeting, STOP and inform the user. Do NOT silently accept the wrong base.

---

## Step 10 -- Return PR URL

After confirmed success (base branch verified), return the PR URL to the user:

```
PR created and verified:
  URL:    https://github.com/<owner>/<repo>/pull/<number>
  Base:   develop
  Title:  feat(auth): add OAuth2 refresh token support
```

---

## When Called from rigor:ship

When invoked as Phase 4 of `rigor:ship`, `$BASE` and the scope policy are already resolved in Phase 0. Do NOT re-detect them -- use the propagated values. Skip Steps 1 and 2 entirely.

Step 3 precondition checks still apply -- Phase 3 (push) should have ensured them, but verify defensively.

---

## Anti-Patterns (FORBIDDEN)

```bash
# WRONG -- no scope (when require_scope is true)
gh pr create --title "feat: add feature" --base main

# WRONG -- invented scope not in allowlist
gh pr create --title "feat(custom-scope): add feature" --base main

# WRONG -- hardcoded base branch
gh pr create --title "feat(auth): add feature" --base develop
# (must use $BASE from Step 1 detection)

# WRONG -- skipping post-create verification
# (Step 9 is NOT optional)

# WRONG -- creating PR with dirty working tree
# (must verify clean tree in Step 3.1)

# WRONG -- creating PR with unpushed commits
# (must verify in Step 3.2 and Step 3.3)

# WRONG -- discarding PR template sections
# (must fill every section heading from the template)

# CORRECT
gh pr create \
  --title "feat(auth): add OAuth2 refresh token support" \
  --body "..." \
  --base "$BASE"
# then verify base in Step 9
```

---

## Anti-Rationalization Table

| Rationalization | Why It Is WRONG | Required Action |
|-----------------|-----------------|-----------------|
| "I know the base branch, I can skip detection" | Any repo can change its default. Detection takes 2 seconds and prevents targeting the wrong branch. | **MUST detect with 3 probes in Step 1** |
| "I will skip the post-create base verification" | `gh pr create --base` can silently pick the wrong base in some edge cases. Verification catches this. | **MUST verify base in Step 9** |
| "The working tree has changes but they are unrelated" | Unrelated changes can leak into the PR diff if not committed or stashed. | **MUST require clean tree in Step 3.1** |
| "The branch is not pushed but I can push and create in one step" | Pushing and PR creation are separate concerns. Push failure should not leave a half-created PR. | **MUST verify branch is pushed in Step 3.2** |
| "I will omit the scope since the PR is small" | When `require_scope` is `true`, scope is mandatory regardless of PR size. | **MUST include scope from allowlist** |
| "This scope is not in the allowlist but it makes sense" | Invented scopes fail automated PR validation checks. | **MUST use only allowlist scopes** |
| "The template has sections that do not apply" | The template exists for consistency. Fill every section -- write "N/A" if truly not applicable. | **MUST fill every template section** |
| "I will create the PR without showing the draft" | The draft exists so the user can catch mistakes in title, body, or base before creation. | **MUST show draft and get approval in Step 7** |
| "The base was wrong but the PR is already created" | Wrong base means wrong diff, wrong merge target, wrong CI checks. Retarget immediately. | **MUST retarget in Step 9 if base is wrong** |
| "No config file means scope is optional" | No config means defaults apply. Default for `require_scope` is `true`. | **Scope is REQUIRED unless config explicitly sets `require_scope: false`** |
| "I will add AI attribution to the PR body" | PR bodies should not contain AI attribution lines. | **Do NOT add AI attribution** |
