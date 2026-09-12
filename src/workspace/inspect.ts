import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

export interface WorkspaceInspection {
  branch: string | null;
  detached: boolean;
  is_linked_worktree: boolean;
  main_worktree_root: string;
}

export class WorkspaceInspectionError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr = "") {
    super(message);
    this.name = "WorkspaceInspectionError";
    this.stderr = stderr;
  }
}

function git(projectRoot: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: projectRoot, encoding: "utf8" }).trim();
  } catch (err) {
    const stderr = err instanceof Error && "stderr" in err
      ? String(err.stderr).trim()
      : "";
    throw new WorkspaceInspectionError(stderr || "Git command failed", stderr);
  }
}

export function inspectWorkspace(projectRoot: string): WorkspaceInspection {
  const root = resolve(projectRoot);
  const bare = git(root, ["rev-parse", "--is-bare-repository"]);
  if (bare === "true") {
    throw new WorkspaceInspectionError("Cannot inspect a bare repository");
  }

  const branchOutput = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const detached = branchOutput === "HEAD";
  const branch = detached ? null : branchOutput;
  const gitDir = resolve(root, git(root, ["rev-parse", "--git-dir"]));
  const commonDir = resolve(root, git(root, ["rev-parse", "--git-common-dir"]));
  const isLinked = gitDir !== commonDir;
  const mainWorktreeRoot = resolve(dirname(commonDir));

  return {
    branch,
    detached,
    is_linked_worktree: isLinked,
    main_worktree_root: isLinked ? mainWorktreeRoot : root,
  };
}
