import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // Exclude nested worktree checkouts under worktrees/ -- those are separate
    // copies of the repo, not part of this project's suite, and their tests
    // otherwise pollute the run (and break it when a worktree is mid-work).
    exclude: [...configDefaults.exclude, "**/worktrees/**", "worktrees/**"],
  },
});
