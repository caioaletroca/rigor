---
name: rigor:commit
description: >-
  Commit changes with scope allowlist enforcement, atomic grouping,
  configurable GPG signing, configurable trailers, and conventional commits.
  Detects the repo's PR-validation scope policy before proposing any message.
  Use when the user asks to commit or has changes ready to record.
  Skip when the working tree is clean or the user wants raw git commands
  without grouping.
---

Analyze changes, enforce scope policy, group them into coherent atomic commits, and create commits following repository conventions. This skill transforms a messy working directory into a clean, logical commit history -- with a scope that will actually pass PR validation.

Configuration is read from `.rigor/config.yaml`. If no config file exists, defaults apply: no GPG signing, no trailers, all standard conventional commit types allowed, scope required.

---

## HARD STOP -- READ SCOPE POLICY AND CONFIG BEFORE ANYTHING ELSE

**The scope is REQUIRED in every commit message. It MUST come from the repo's allowlist.**

MUST detect the allowlist in Step 0 before analyzing or drafting any commit message. A commit with an invented or omitted scope will fail PR validation and block the PR.

MUST read `.rigor/config.yaml` in Step 0 to determine GPG signing and trailer settings. These values control the exact `git commit` command structure for the entire session.

---

## Step 0 -- Detect Scope Policy and Load Config

### 0.1 -- Load Rigor Config

Read `.rigor/config.yaml` from the repository root. Extract:

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `commit.gpg_sign` | boolean | `false` | If `true`, use `-S` flag on every commit |
| `commit.trailers` | list of `{key, value}` | `[]` (empty) | Each entry becomes `--trailer "Key: Value"` |
| `commit.types` | list of strings | all standard types | Restricts allowed conventional commit types |
| `commit.require_scope` | boolean | `true` | Whether scope is mandatory |

If the file does not exist, use all defaults. Do NOT prompt the user to create a config file -- just proceed with defaults.

### 0.2 -- Locate the Scope Policy File

Check in this order:

1. `.github/workflows/pr-validation.yml` (primary)
2. `.github/workflows/pr-title.yml`
3. `.github/workflows/commitlint.yml`
4. `.github/workflows/semantic-pull-request.yml`
5. Root configs: `commitlint.config.{js,cjs,mjs,ts}`, `.commitlintrc*`

### 0.3 -- Extract the Allowed Scope List

Common forms to look for:

| Form | Example |
|------|---------|
| `scopes:` block (one per line) | Under `amannn/action-semantic-pull-request` |
| `scopes: a,b,c` inline | Comma-separated on one line |
| `scope-enum` rule | In commitlint config arrays |

Also note any **type** restrictions -- some repos limit types beyond the default Conventional Commits set. If the config also specifies `commit.types`, the intersection of both constraints applies.

### 0.4 -- Apply the Policy

| Situation | Required Action |
|-----------|-----------------|
| Policy found, scope is clear | Use only scopes from the allowlist |
| Policy found, scope is ambiguous | STOP and confirm with the user which allowed scope to use |
| No policy file found, `require_scope` is `true` | MUST still include a scope -- confirm with the user what scope to use |
| No policy file found, `require_scope` is `false` | Scope is optional -- include one if it adds clarity, omit if not |

When `require_scope` is `true` (the default): **NEVER** omit the scope. **NEVER** invent a scope not in the allowlist. A bare `type: description` is FORBIDDEN.

State the policy source and chosen scope to the user before proceeding.

---

## Step 1 -- Gather Context

Run in parallel:

```bash
git status
git diff
git diff --cached
git log --oneline -10
```

---

## Step 2 -- Analyze and Group Changes

For each changed file determine:
1. **Type**: from the allowed types (default: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `style`, `perf`, `ci`, `build`)
2. **Scope**: from the allowlist resolved in Step 0
3. **Logical group**: what other files belong with this change?

### Grouping Principles

| Principle | Description |
|-----------|-------------|
| **Feature + Tests** | Implementation and its tests go together |
| **Config Changes** | `package.json`, `tsconfig`, etc. grouped separately |
| **Documentation** | `README`, `docs/` changes grouped together |
| **Refactoring** | Pure refactors (no behavior change) separate |
| **Bug Fixes** | Each fix is atomic with its test |

### Single vs Multiple Commits

**Single commit when:**
- All changes belong to one coherent feature/fix
- User provides a specific message via argument
- Changes are minimal and related

**Multiple commits when:**
- Changes span different concerns (feature + docs + deps)
- Mix of features, fixes, and chores
- Better git history benefits future archaeology

---

## Step 3 -- Determine Commit Order

Order matters for bisectability:

1. **Dependencies first** -- so subsequent commits can use them
2. **Core changes** -- implementation before consumers
3. **Tests with implementation** -- keep them atomic
4. **Documentation last** -- documents the final state

---

## Step 4 -- Present Plan and Confirm

MUST get user confirmation before executing.

```
Proposed Commit Plan:
---------------------
Config:       .rigor/config.yaml (gpg_sign: true, trailers: 1 configured)
Scope policy: .github/workflows/pr-validation.yml -> allowed scopes: [api, auth, docs, ci]
Chosen scope: auth

1. feat(auth): add OAuth2 refresh token support
   - src/auth/oauth.ts (modified)
   - src/auth/oauth.test.ts (modified)

2. chore(deps): update authentication dependencies
   - package.json (modified)
   - package-lock.json (modified)

3. docs(docs): update OAuth2 setup guide
   - docs/auth/oauth-setup.md (modified)

Proceed with this plan? [Execute plan / Single commit / Let me review]
```

Confirm with the user before proceeding.

---

## Step 5 -- Draft Commit Messages

Every commit message MUST follow:

```
<type>(<scope>): <subject>

<body -- optional>
```

- Subject: max 50 characters, imperative mood ("add" not "added")
- Body: wrap at 72 characters, explain motivation/context
- Scope: REQUIRED by default (see Step 0.4 for `require_scope: false` exception)
- Type: MUST be from the allowed types list

---

## Step 6 -- Execute Commits

### HARD STOP -- TRAILER RULES

If `.rigor/config.yaml` defines trailers, each trailer MUST be passed as a separate `--trailer` flag OUTSIDE the `-m` quotes.

**THE MOST COMMON MISTAKE:** Putting trailer text INSIDE the `-m` quotes.

```bash
# WRONG -- trailer text is INSIDE the -m quotes
git commit -m "feat(auth): add feature

X-Custom-Ref: abc123"

# CORRECT -- --trailer is a SEPARATE argument OUTSIDE quotes
git commit -m "feat(auth): add feature" --trailer "X-Custom-Ref: abc123"
```

**Before writing ANY git commit command, verify:**

- [ ] `-m "..."` contains ONLY the commit message (no trailer text inside)
- [ ] `--trailer` flags are OUTSIDE and AFTER the `-m` parameter (only if trailers configured)
- [ ] `-S` is present (only if `gpg_sign: true` in config)

### Command Structure

The exact command depends on config:

**GPG signing enabled + trailers configured:**
```bash
git commit -S \
  -m "<type>(<scope>): <subject>" \
  -m "<body if needed>" \
  --trailer "Key1: Value1" \
  --trailer "Key2: Value2"
```

**GPG signing enabled + no trailers:**
```bash
git commit -S \
  -m "<type>(<scope>): <subject>" \
  -m "<body if needed>"
```

**No GPG signing + trailers configured:**
```bash
git commit \
  -m "<type>(<scope>): <subject>" \
  -m "<body if needed>" \
  --trailer "Key1: Value1"
```

**No GPG signing + no trailers (minimal):**
```bash
git commit \
  -m "<type>(<scope>): <subject>" \
  -m "<body if needed>"
```

For each commit group, in order:

1. Stage only the files for this commit:
   ```bash
   git add <file1> <file2> ...
   ```

2. Create commit with the appropriate flags per config:
   ```bash
   git commit [-S] \
     -m "<type>(<scope>): <subject>" \
     -m "<body if needed>" \
     [--trailer "Key: Value" ...]
   ```

3. Repeat for each commit group.

### GPG Signing Failure (only when `gpg_sign: true`)

If GPG signing is enabled in config and signing fails: check `git config user.signingkey` and `gpg --list-secret-keys`.

If no usable key is found, STOP -- do NOT offer an unsigned path. Inform the user:

```
GPG signing is enabled in .rigor/config.yaml but no usable signing key was found.

To proceed:
  1. Generate a key: gpg --gen-key
  2. Configure git:  git config --global user.signingkey <key-id>
  3. Re-run this skill.

Or disable GPG signing in .rigor/config.yaml:
  commit:
    gpg_sign: false
```

MUST wait for the user to configure a key or disable signing before continuing. NEVER drop `-S` silently.

---

## Step 7 -- Verify Commits

First, resolve the range ref for verification. `$BASE` may be provided by an orchestrating skill (e.g., `rigor:ship`). Resolve in this order:

```bash
# 1. Upstream tracking ref (works when branch already has a remote tracking branch)
if git rev-parse @{u} >/dev/null 2>&1; then
  RANGE_REF="@{u}"

# 2. $BASE propagated by the orchestrating skill (e.g., rigor:ship)
elif [ -n "$BASE" ]; then
  RANGE_REF="origin/$BASE"

# 3. Standalone: detect base branch via GitHub API
else
  BASE=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null \
    || git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}')
  RANGE_REF="origin/$BASE"
fi
```

Then verify every commit in the batch. The verification checks depend on config:

```bash
git log --oneline "$RANGE_REF..HEAD"

for commit in $(git rev-list "$RANGE_REF..HEAD"); do
  # --- GPG signature check (only if gpg_sign is enabled in config) ---
  # %G? returns: G=good, U=unknown-validity, X/Y=expired, B=bad, E=missing key, N=no signature
  sig_status=$(git log -1 --format="%G?" "$commit")
  echo "$sig_status" | grep -qE '^[GU]' \
    || { echo "Commit $commit: signature invalid or insufficient (status=$sig_status)"; exit 1; }

  # --- Trailer check (only if trailers are configured) ---
  # For each configured trailer key, verify it exists
  git log -1 --format="%(trailers)" "$commit" | grep -q '^<TrailerKey>: ' \
    || { echo "Commit $commit: <TrailerKey> trailer missing"; exit 1; }
done

git status
```

**Conditional verification rules:**

| Config Setting | Verification |
|----------------|-------------|
| `gpg_sign: true` | Check signature status. Accept `G` (good) or `U` (unknown validity). Reject `X`/`Y` (expired), `B` (bad), `E` (missing key), `N` (unsigned). |
| `gpg_sign: false` (or not set) | Skip signature verification entirely |
| `trailers` list is non-empty | For each configured trailer key, verify it appears in the commit trailers |
| `trailers` is empty (or not set) | Skip trailer verification entirely |

**Why `U` is accepted for GPG:** `U` means the commit is cryptographically signed with a valid key, but GPG has not established a trust chain for that key (e.g., the key was not signed by a trusted introducer). This is the normal state for freshly generated keys or keys imported from colleagues without manual trust assignment. The signature itself is valid -- it proves authorship. `G` additionally requires GPG's web-of-trust to vouch for the key identity, which is stricter than needed for commit attribution. Both are acceptable; only unsigned (`N`), bad (`B`), missing-key (`E`), and expired-key (`X`/`Y`) commits are rejected.

Note: when called from `rigor:ship`, `$BASE` is already resolved in Phase 0 and propagated here -- the `@{u}` and standalone detection paths are only needed for standalone invocations.

---

## Step 8 -- Offer Push

After successful commit, ask the user whether to push commits to the remote.

If yes:
```bash
# Branch with upstream:
git push

# Branch without upstream:
git push -u origin <current-branch>
```

---

## Examples

### Feature commit (GPG + trailers configured)
```bash
git commit -S \
  -m "feat(auth): add OAuth2 refresh token support" \
  -m "Implements automatic token refresh when access token expires." \
  --trailer "Signed-off-by: Jane Doe <jane@example.com>"
```

### Bug fix (no GPG, no trailers)
```bash
git commit \
  -m "fix(api): handle null response in user endpoint"
```

### Chore (GPG only, no trailers)
```bash
git commit -S \
  -m "chore(deps): update dependencies to latest versions"
```

### Docs (trailers only, no GPG)
```bash
git commit \
  -m "docs(readme): update installation instructions" \
  --trailer "X-Project-Ref: docs-refresh"
```

---

## Anti-Patterns (FORBIDDEN)

```bash
# WRONG -- no scope (when require_scope is true)
git commit -m "feat: add feature"

# WRONG -- invented scope not in allowlist
git commit -m "feat(custom-scope): add feature"

# WRONG -- trailer text inside -m
git commit -m "feat(auth): add feature

Signed-off-by: Jane Doe <jane@example.com>"

# WRONG -- using -S when gpg_sign is not enabled in config
git commit -S -m "feat(auth): add feature"

# WRONG -- omitting -S when gpg_sign IS enabled in config
git commit -m "feat(auth): add feature"

# WRONG -- omitting configured trailers
git commit -m "feat(auth): add feature"
# (when .rigor/config.yaml defines trailers)

# CORRECT (gpg_sign: true, one trailer configured)
git commit -S \
  -m "feat(auth): add feature" \
  --trailer "Signed-off-by: Jane Doe <jane@example.com>"

# CORRECT (gpg_sign: false, no trailers)
git commit \
  -m "feat(auth): add feature"
```

---

## Trailer Query Commands

```bash
# Find commits with specific trailer value
git log --all --format="%H %s %(trailers:key=Signed-off-by,valueonly)" | grep "Jane"

# Show all trailers for a commit
git log -1 --format="%(trailers)"
```

---

## When User Provides Message

If the user provides a commit message as an argument:
1. Use it as the subject/body
2. Validate it has a scope from the allowlist (if `require_scope` is true) -- if missing, ask which scope to use
3. Validate the type is in the allowed types list
4. Create commit with appropriate flags per config

---

## Anti-Rationalization Table

| Rationalization | Why It Is WRONG | Required Action |
|-----------------|-----------------|-----------------|
| "I will omit the scope for this one" | Every commit MUST carry a scope when `require_scope` is true (the default). A bare `type: description` fails PR validation. | **MUST include scope from allowlist** |
| "This scope is not in the allowlist but it makes sense" | Invented scopes fail automated checks. The allowlist exists for a reason. | **MUST use only allowlist scopes or confirm with user** |
| "No policy file, so scope is optional" | If `require_scope` is `true` (default), scope is always required. Without a policy, confirm with the user which scope to use. | **MUST confirm with user for scope if no policy found** |
| "I will commit everything at once" | Mixed changes = messy history, hard to bisect/revert. | **Analyze and group changes first** |
| "Grouping takes too long" | Clean history saves hours of debugging later. | **Always propose commit plan** |
| "I will put the trailer text in the message body" | `--trailer` is a GIT FLAG, not message text. | **Use `--trailer "Key: Value"` as separate argument** |
| "I will skip GPG signing" | If `gpg_sign` is `true` in config, unsigned commits fail Step 7 verification. There is no unsigned fallback -- configure a key or disable in config. | **MUST use `-S` when gpg_sign is enabled. NEVER drop `-S` silently** |
| "GPG signing is not in the config so I will add -S anyway" | Adding `-S` when config does not enable it introduces unexpected behavior. Respect the config. | **Only use `-S` when `gpg_sign: true` in config** |
| "HEREDOC will format trailers correctly" | HEREDOC puts everything in the message body. | **Use `--trailer` flag, NOT HEREDOC** |
| "No config file, so I will skip trailers and signing" | Correct -- but only because the defaults are no trailers and no signing. State this explicitly to the user. | **Proceed with defaults, inform user that defaults are being used** |
| "The config has trailers but this commit does not need them" | Configured trailers apply to ALL commits. They are not optional per-commit. | **MUST include all configured trailers on every commit** |
