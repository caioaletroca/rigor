import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectWorkspace, WorkspaceInspectionError } from "../inspect.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "rigor-workspace-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  return root;
}

describe("inspectWorkspace", () => {
  it("reports a linked worktree and its feature branch", () => {
    const root = repository();
    const linked = mkdtempSync(join(tmpdir(), "rigor-linked-"));
    try {
      git(root, "commit", "--allow-empty", "-m", "initial");
      git(root, "worktree", "add", "-b", "feature/test", linked);
      expect(inspectWorkspace(linked)).toEqual({
        branch: "feature/test",
        detached: false,
        is_linked_worktree: true,
        main_worktree_root: root,
      });
    } finally {
      git(root, "worktree", "remove", "--force", linked);
      rmSync(root, { recursive: true, force: true });
      rmSync(linked, { recursive: true, force: true });
    }
  });

  it("reports detached HEAD", () => {
    const root = repository();
    try {
      git(root, "commit", "--allow-empty", "-m", "initial");
      git(root, "checkout", "--detach");
      expect(inspectWorkspace(root)).toMatchObject({ branch: null, detached: true, is_linked_worktree: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports the main worktree", () => {
    const root = repository();
    try {
      git(root, "commit", "--allow-empty", "-m", "initial");
      expect(inspectWorkspace(root)).toEqual({ branch: "main", detached: false, is_linked_worktree: false, main_worktree_root: root });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("throws a typed error for git failure", () => {
    const root = mkdtempSync(join(tmpdir(), "rigor-not-git-"));
    try { expect(() => inspectWorkspace(root)).toThrow(WorkspaceInspectionError); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("throws for a bare repository", () => {
    const root = mkdtempSync(join(tmpdir(), "rigor-bare-"));
    try {
      git(root, "init", "--bare");
      expect(() => inspectWorkspace(root)).toThrow(WorkspaceInspectionError);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
