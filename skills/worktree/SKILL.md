---
name: rigor:worktree
description: >-
  Create a collision-safe isolated git worktree, verify ignored state, install dependencies,
  and establish a passing baseline. Use before isolated feature work or plan execution.
  Skip for quick fixes on the current branch or when already in the task's worktree.
---
# rigor:worktree

Set up one isolated worktree and branch for one unit of work before implementation.

## Step 0 -- Confirm whether a worktree may be created at all

This skill creates a workspace. It is for the agent that owns the unit of work, not for a delegate executing inside an existing one.

Before anything else, determine whether an assigned workspace already exists:

- If the caller named an assigned worktree path, do NOT run this skill. Verify that path and work there.
- If the current checkout is already the assigned worktree for this unit of work, stop and report that; never nest a new worktree inside it.
- Only create a worktree when this agent owns the unit of work and no workspace has been assigned.

A delegated implementer must verify its workspace instead of creating one:

```bash
git rev-parse --show-toplevel
```

Proceed only when that value matches the assigned path exactly. If it does not match, stop and report the mismatch; do not create, enter, or edit any other worktree, and do not "fix" the situation by branching a new one.

## Step 1 -- Select the worktree directory

Use this priority order:

1. Existing `.worktrees/` directory.
2. Existing `worktrees/` directory.
3. `.rigor/config.yaml` `worktree.directory`.
4. `CLAUDE.md` worktree-directory preference.
5. Ask the user to choose project-local `.worktrees/` or global `~/.config/rigor/worktrees/<project>/`.

If both project-local directories exist, use `.worktrees/`. Do not infer a location when the configured choices conflict.

## Step 2 -- Select the base branch

Inspect repository metadata and identify the likely integration branch with `git remote show origin`, remote-tracking branches, and recent history. If the base branch is not unambiguous, use the formal question mechanism:

> Which branch should this worktree branch from?
>
> 1. `<detected default branch>` (Recommended)
> 2. `<other plausible branch>`
> 3. Enter another branch name

Do not create the worktree until the user answers. Verify the selected base branch exists before proceeding.

## Step 3 -- Verify ignored state

For a project-local directory, verify that `.worktrees/` or `worktrees/` is ignored before creation. If it is missing, add only the appropriate ignore entry and stop for the user to commit it; never commit unrelated changes. Global directories require no project `.gitignore` change.

Use `git check-ignore -q <directory>` or an equivalent anchored `.gitignore` check, and verify the intended path rather than merely checking that `.gitignore` exists.

## Step 4 -- Create collision-safe names

Derive a named path and branch from the task or feature identifier, using lowercase hyphen-separated names, such as `.worktrees/1-2-1-worktree` and `feat/1-2-1-worktree`. Before creation, inspect `git worktree list`, the filesystem, and `git branch --list <branch>`.

If either name is taken, choose a fresh deterministic suffix such as `-2`, re-check it, and never reuse another agent's worktree. Create and enter only the worktree created by this operation:

```bash
git worktree add <path> -b <branch> <base-branch>
```

Treat an existing-path or existing-branch error as a collision and retry with a fresh name.

## Step 5 -- Install and establish a baseline

In the new worktree, detect the project toolchain and install dependencies using the repository's documented command. For trusted repositories, lifecycle scripts may run; for untrusted sources, use the project's script-free option or ask first.

Run the configured Gate 0 test command from `.rigor/config.yaml`, preferring the `tests` check. If none exists, use the repository's documented test command. A failing baseline stops the setup and must be reported before implementation.

Report the created path, branch, install result, and baseline result before handing off the worktree.

## Non-Negotiables

- One agent owns one worktree and branch.
- A delegated agent uses only its assigned worktree and verifies `git rev-parse --show-toplevel` matches it before editing.
- A delegated agent never runs `git worktree add`, invokes `rigor:worktree`, enters another worktree, or edits the main checkout.
- Project-local worktree paths must be ignored before creation.
- Base branch ambiguity requires the formal question.
- Names must be checked for collisions before `git worktree add`.
- Dependencies and the baseline must be verified before implementation.

## Anti-Patterns (FORBIDDEN)

- Creating a project-local worktree before checking its ignore rule.
- Guessing the base branch when more than one branch is plausible.
- Reusing an existing worktree or branch.
- Running setup or tests in the main workspace instead of the newly created worktree.
- Proceeding after a failing baseline without reporting it.
- Committing `.gitignore` together with unrelated changes.
- Creating a second worktree for a task that was already assigned one.
- Editing the main checkout, or any worktree other than the assigned one, while implementing a delegated task.
- Editing before confirming `git rev-parse --show-toplevel` matches the assigned path.

## Anti-Rationalization Table

| Rationalization | Why It Is WRONG | Required Action |
|---|---|---|
| "The default branch is obvious" | Repository remotes and local conventions can disagree. | Inspect metadata; ask the formal question when ambiguous. |
| "The directory is probably ignored" | A broad or unrelated ignore rule may not protect the selected path. | Verify the exact project-local directory before creation. |
| "Git will reject duplicate names" | Failure wastes time and can encourage reusing another agent's workspace. | Pre-check path and branch, then select a fresh suffix. |
| "Dependencies are already installed elsewhere" | Worktrees do not guarantee a valid or complete local dependency state. | Install in the new worktree using project conventions. |
| "The baseline failure is unrelated" | Without a recorded baseline, new regressions cannot be distinguished. | Stop and report the failure before implementation. |
| "Sharing saves a worktree" | Agents can overwrite files and invalidate each other's verification. | Enforce one agent per worktree and branch. |
| "I can create my own worktree for this delegated task" | The parent cycle, branch history, and `.rigor` evidence belong to the assigned workspace; a new worktree silently forks the task. | Verify the assigned top-level path exactly and stop on mismatch. |
| "The main checkout is close enough" | Main may contain unrelated changes and does not own the delegated cycle state. | Never edit it; use only the assigned worktree. |
| "The assigned path is probably correct" | A wrong working directory makes every edit and gate result belong to another workspace. | Run `git rev-parse --show-toplevel` before editing and require an exact match. |
