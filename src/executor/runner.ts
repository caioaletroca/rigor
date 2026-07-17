/**
 * Shell command runner — executes commands and returns structured results.
 *
 * Uses `spawnSync` with `shell: true` so commands with pipes, redirects,
 * and other shell features work out of the box.  Never throws on non-zero
 * exit codes; the caller decides what constitutes failure.
 */

import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandResult {
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
}

export interface RunOptions {
  cwd: string;
  timeout_ms?: number;
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Execute a shell command and return a structured result.
 *
 * - Empty commands short-circuit with `exit_code: 0`.
 * - Timeouts set `timed_out: true` and `exit_code: -1`.
 * - Non-zero exit codes are captured, never thrown.
 */
export function runCommand(command: string, options: RunOptions): CommandResult {
  if (command === "") {
    return {
      command,
      exit_code: 0,
      stdout: "",
      stderr: "",
      duration_ms: 0,
      timed_out: false,
    };
  }

  const timeout = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const env = options.env
    ? { ...process.env, ...options.env }
    : process.env;

  const start = Date.now();

  const result = spawnSync(command, {
    shell: true,
    cwd: options.cwd,
    timeout,
    env,
    encoding: "utf-8",
    // Cap buffer at 10 MB to avoid OOM on chatty commands.
    maxBuffer: 10 * 1024 * 1024,
  });

  const duration_ms = Date.now() - start;

  // spawnSync sets `error.code === "ETIMEDOUT"` when the timeout fires.
  const timed_out = result.error?.message?.includes("ETIMEDOUT") ?? false;

  return {
    command,
    exit_code: timed_out ? -1 : (result.status ?? -1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    duration_ms,
    timed_out,
  };
}
