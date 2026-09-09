import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  it("captures stdout from a simple command", async () => {
    const result = await runCommand("echo hello", { cwd: tmpDir });

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
  it("captures stderr and non-zero exit code without throwing", async () => {
    const result = await runCommand(
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
  it("records non-zero exit code without throwing", async () => {
    const result = await runCommand(
      'node -e "process.exit(42)"',
      { cwd: tmpDir },
    );

    expect(result.exit_code).toBe(42);
    expect(result.timed_out).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 4. Empty command — returns immediately with exit_code 0
  // -----------------------------------------------------------------------
  it("returns immediately with exit_code 0 for empty command", async () => {
    const result = await runCommand("", { cwd: tmpDir });

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.duration_ms).toBe(0);
    expect(result.timed_out).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 5. Timeout — kills long-running command
  // -----------------------------------------------------------------------
  it("kills a command that exceeds the timeout", async () => {
    // Use the OS temp root as cwd to avoid EBUSY on Windows when the
    // killed process still holds a handle on the test-specific tmpDir.
    const result = await runCommand(
      'node -e "setTimeout(()=>{},10000)"',
      { cwd: tmpdir(), timeout_ms: 500 },
    );

    expect(result.timed_out).toBe(true);
    expect(result.exit_code).toBeUndefined();
  });

  it("closes stdin so commands waiting for EOF complete", async () => {
    const result = await runCommand('node -e "process.stdin.resume(); process.stdin.on(\'end\', () => process.stdout.write(\'done\'))"', {
      cwd: tmpdir(),
    });

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("done");
  });

  it("does not block the event loop while a command runs", async () => {
    let timerFired = false;
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 25);
    });

    const command = runCommand('node -e "setTimeout(()=>{},100)"', {
      cwd: tmpdir(),
    });
    await timer;
    await command;

    expect(timerFired).toBe(true);
  });

  it("caps combined stdout and stderr at 10 MB", async () => {
    const result = await runCommand(
      'node -e "const chunk=\'x\'.repeat(6*1024*1024); process.stdout.write(chunk); process.stderr.write(chunk)"',
      { cwd: tmpdir() },
    );

    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(10 * 1024 * 1024);
    expect(result.stdout.length + result.stderr.length).toBeGreaterThan(0);
  });

  it("reports cancellation separately from command failure", async () => {
    const controller = new AbortController();
    const command = runCommand('node -e "setTimeout(()=>{},10000)"', {
      cwd: tmpdir(),
      signal: controller.signal,
    });
    controller.abort();

    const result = await command;
    expect(result.cancelled).toBe(true);
    expect(result.timed_out).toBe(false);
    expect(result.exit_code).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // 6. Custom cwd — runs in the specified directory
  // -----------------------------------------------------------------------
  it("runs the command in the specified working directory", async () => {
    // `node -e` is portable across platforms for printing cwd.
    const result = await runCommand(
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
  it("passes custom environment variables to the command", async () => {
    const result = await runCommand(
      'node -e "process.stdout.write(process.env.RIGOR_TEST_VAR || \'\')"',
      { cwd: tmpDir, env: { RIGOR_TEST_VAR: "works" } },
    );

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("works");
  });
});
