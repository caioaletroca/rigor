/**
 * Tests for custom gate runner.
 *
 * Mocks the executor module to avoid running real shell commands.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RigorConfig } from "../../config/index.js";
import { DEFAULTS } from "../../config/index.js";
import type { CustomGateConfig } from "../../config/schema.js";
import type { CommandResult } from "../../executor/index.js";

// ---------------------------------------------------------------------------
// Mock the executor
// ---------------------------------------------------------------------------

vi.mock("../../executor/index.js", () => ({
  runCommand: vi.fn(),
}));

// Import AFTER mock setup so the module picks up the mock.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const { runCommand } = await import("../../executor/index.js") as {
  runCommand: ReturnType<typeof vi.fn>;
};

const { runCustomGates } = await import("../custom.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(customGates: CustomGateConfig[]): RigorConfig {
  return {
    ...DEFAULTS,
    gates: {
      ...DEFAULTS.gates,
      custom_gates: customGates,
    },
  };
}

function okResult(): CommandResult {
  return {
    command: "test-cmd",
    exit_code: 0,
    stdout: "",
    stderr: "",
    duration_ms: 100,
    timed_out: false,
  };
}

function failResult(exitCode: number = 1): CommandResult {
  return {
    command: "test-cmd",
    exit_code: exitCode,
    stdout: "",
    stderr: "error output",
    duration_ms: 50,
    timed_out: false,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("runCustomGates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. No custom gates configured
  // -----------------------------------------------------------------------
  it("returns passed with empty checks when no custom gates are configured", () => {
    const config = makeConfig([]);

    const result = runCustomGates("pre_task", "1.1.1", config, "/project");

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(0);
    expect(runCommand).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 2. Gates for a different position are filtered out
  // -----------------------------------------------------------------------
  it("filters out gates for a different position and returns passed", () => {
    const config = makeConfig([
      { name: "lint", command: "npm run lint", position: "post_task" },
      { name: "format", command: "npm run format", position: "pre_review" },
    ]);

    const result = runCustomGates("pre_task", "1.1.1", config, "/project");

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(0);
    expect(runCommand).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 3. Single passing gate
  // -----------------------------------------------------------------------
  it("returns passed with one check when a single gate succeeds", () => {
    const config = makeConfig([
      { name: "lint", command: "npm run lint", position: "pre_task" },
    ]);

    runCommand.mockReturnValue(okResult());

    const result = runCustomGates("pre_task", "1.1.1", config, "/project");

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].passed).toBe(true);
    expect(result.checks[0].name).toBe("custom:lint");
    expect(result.checks[0].detail).toContain("lint");
    expect(result.checks[0].detail).toContain("passed");
  });

  // -----------------------------------------------------------------------
  // 4. Single failing gate
  // -----------------------------------------------------------------------
  it("returns failed with one check when a single gate fails", () => {
    const config = makeConfig([
      { name: "typecheck", command: "npx tsc --noEmit", position: "post_task" },
    ]);

    runCommand.mockReturnValue(failResult(2));

    const result = runCustomGates("post_task", "1.1.1", config, "/project");

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].passed).toBe(false);
    expect(result.checks[0].name).toBe("custom:typecheck");
    expect(result.checks[0].detail).toContain("typecheck");
    expect(result.checks[0].detail).toContain("failed");
    expect(result.checks[0].detail).toContain("exit code 2");
  });

  // -----------------------------------------------------------------------
  // 5. Multiple gates — first passes, second fails (short-circuit)
  // -----------------------------------------------------------------------
  it("short-circuits on first failure and only returns checks up to that point", () => {
    const config = makeConfig([
      { name: "lint", command: "npm run lint", position: "pre_review" },
      { name: "typecheck", command: "npx tsc --noEmit", position: "pre_review" },
      { name: "audit", command: "npm audit", position: "pre_review" },
    ]);

    runCommand
      .mockReturnValueOnce(okResult())
      .mockReturnValueOnce(failResult(1));

    const result = runCustomGates("pre_review", "1.1.1", config, "/project");

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0].passed).toBe(true);
    expect(result.checks[0].name).toBe("custom:lint");
    expect(result.checks[1].passed).toBe(false);
    expect(result.checks[1].name).toBe("custom:typecheck");
    // Third gate ("audit") should not have been called.
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // 6. Multiple gates — all pass
  // -----------------------------------------------------------------------
  it("returns passed with all checks when every gate succeeds", () => {
    const config = makeConfig([
      { name: "lint", command: "npm run lint", position: "post_accept" },
      { name: "typecheck", command: "npx tsc --noEmit", position: "post_accept" },
      { name: "audit", command: "npm audit", position: "post_accept" },
    ]);

    runCommand.mockReturnValue(okResult());

    const result = runCustomGates("post_accept", "1.1.1", config, "/project");

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(3);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(runCommand).toHaveBeenCalledTimes(3);
  });

  // -----------------------------------------------------------------------
  // 7. Gate name appears in check name as `custom:<name>`
  // -----------------------------------------------------------------------
  it("prefixes check names with 'custom:' and the gate name", () => {
    const config = makeConfig([
      { name: "my-special-gate", command: "echo ok", position: "pre_task" },
    ]);

    runCommand.mockReturnValue(okResult());

    const result = runCustomGates("pre_task", "1.1.1", config, "/project");

    expect(result.checks[0].name).toBe("custom:my-special-gate");
  });

  // -----------------------------------------------------------------------
  // 8. Passes cwd and timeout_ms to runCommand
  // -----------------------------------------------------------------------
  it("passes cwd and timeout_ms to runCommand", () => {
    const config = makeConfig([
      { name: "slow-check", command: "long-cmd", position: "pre_task", timeout_ms: 5000 },
    ]);

    runCommand.mockReturnValue(okResult());

    runCustomGates("pre_task", "1.1.1", config, "/my/project");

    expect(runCommand).toHaveBeenCalledWith("long-cmd", {
      cwd: "/my/project",
      timeout_ms: 5000,
    });
  });

  // -----------------------------------------------------------------------
  // 9. Passes undefined timeout_ms when not configured
  // -----------------------------------------------------------------------
  it("passes undefined timeout_ms when not configured on the gate", () => {
    const config = makeConfig([
      { name: "quick-check", command: "echo ok", position: "pre_task" },
    ]);

    runCommand.mockReturnValue(okResult());

    runCustomGates("pre_task", "1.1.1", config, "/project");

    expect(runCommand).toHaveBeenCalledWith("echo ok", {
      cwd: "/project",
      timeout_ms: undefined,
    });
  });
});
