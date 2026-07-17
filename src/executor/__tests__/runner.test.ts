import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCommand } from "../runner.js";

describe("runCommand", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rigor-exec-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 1. Simple command — captures stdout, exit_code 0
  // -----------------------------------------------------------------------
  it("captures stdout from a simple command", () => {
    const result = runCommand("echo hello", { cwd: tmpDir });

    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
    expect(result.timed_out).toBe(false);
    expect(result.command).toBe("echo hello");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  // -----------------------------------------------------------------------
  // 2. Failing command — captures stderr, non-zero exit code
  // -----------------------------------------------------------------------
  it("captures stderr and non-zero exit code without throwing", () => {
    const result = runCommand(
      'node -e "process.stderr.write(\'err\\n\'); process.exit(1)"',
      { cwd: tmpDir },
    );

    expect(result.exit_code).toBe(1);
    expect(result.stderr.trim()).toBe("err");
    expect(result.timed_out).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 3. Non-zero exit code — never throws
  // -----------------------------------------------------------------------
  it("records non-zero exit code without throwing", () => {
    const result = runCommand(
      'node -e "process.exit(42)"',
      { cwd: tmpDir },
    );

    expect(result.exit_code).toBe(42);
    expect(result.timed_out).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 4. Empty command — returns immediately with exit_code 0
  // -----------------------------------------------------------------------
  it("returns immediately with exit_code 0 for empty command", () => {
    const result = runCommand("", { cwd: tmpDir });

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.duration_ms).toBe(0);
    expect(result.timed_out).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 5. Timeout — kills long-running command
  // -----------------------------------------------------------------------
  it("kills a command that exceeds the timeout", () => {
    // Use the OS temp root as cwd to avoid EBUSY on Windows when the
    // killed process still holds a handle on the test-specific tmpDir.
    const result = runCommand(
      'node -e "setTimeout(()=>{},10000)"',
      { cwd: tmpdir(), timeout_ms: 500 },
    );

    expect(result.timed_out).toBe(true);
    expect(result.exit_code).toBe(-1);
  });

  // -----------------------------------------------------------------------
  // 6. Custom cwd — runs in the specified directory
  // -----------------------------------------------------------------------
  it("runs the command in the specified working directory", () => {
    // `node -e` is portable across platforms for printing cwd.
    const result = runCommand(
      'node -e "process.stdout.write(process.cwd())"',
      { cwd: tmpDir },
    );

    expect(result.exit_code).toBe(0);
    // Normalize to forward slashes for cross-platform comparison.
    const actual = result.stdout.trim().replace(/\\/g, "/").toLowerCase();
    const expected = tmpDir.replace(/\\/g, "/").toLowerCase();
    expect(actual).toBe(expected);
  });

  // -----------------------------------------------------------------------
  // 7. Custom env — merges with process.env
  // -----------------------------------------------------------------------
  it("passes custom environment variables to the command", () => {
    const result = runCommand(
      'node -e "process.stdout.write(process.env.RIGOR_TEST_VAR || \'\')"',
      { cwd: tmpDir, env: { RIGOR_TEST_VAR: "works" } },
    );

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("works");
  });
});
