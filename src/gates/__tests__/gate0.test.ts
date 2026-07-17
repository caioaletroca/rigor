/**
 * Tests for Gate 0 exit-criteria logic.
 *
 * Mocks the executor module to avoid running real shell commands.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RigorConfig } from "../../config/index.js";
import { DEFAULTS } from "../../config/index.js";
import type { CommandResult } from "../../executor/index.js";

// ---------------------------------------------------------------------------
// Mock the executor
// ---------------------------------------------------------------------------

vi.mock("../../executor/index.js", () => ({
  runCommand: vi.fn(),
  parseCoverage: vi.fn(),
}));

// Import AFTER mock setup so the module picks up the mock.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const { runCommand } = await import("../../executor/index.js") as {
  runCommand: ReturnType<typeof vi.fn>;
  parseCoverage: ReturnType<typeof vi.fn>;
};
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const { parseCoverage } = await import("../../executor/index.js") as {
  parseCoverage: ReturnType<typeof vi.fn>;
};

const { checkGate0Exit } = await import("../gate0.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<RigorConfig["gates"]["gate_0"]>): RigorConfig {
  return {
    ...DEFAULTS,
    gates: {
      ...DEFAULTS.gates,
      gate_0: {
        ...DEFAULTS.gates.gate_0,
        ...overrides,
      },
    },
  };
}

function okResult(stdout: string = ""): CommandResult {
  return {
    command: "test-cmd",
    exit_code: 0,
    stdout,
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

describe("checkGate0Exit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. Passes when tests succeed and coverage meets threshold
  // -----------------------------------------------------------------------
  it("passes when test command succeeds and coverage meets threshold", async () => {
    const config = makeConfig({
      test_command: "npm test",
      lint_command: "",
      coverage_threshold: 80,
      require_test_files: false,
    });

    runCommand.mockReturnValue(okResult("Statements : 90%"));
    parseCoverage.mockReturnValue(90);

    const result = await checkGate0Exit("1.1.1", config, "/project");

    expect(result.passed).toBe(true);
    expect(result.coverage).toBe(90);

    const testCheck = result.checks.find((c) => c.name === "tests");
    expect(testCheck?.passed).toBe(true);

    const covCheck = result.checks.find((c) => c.name === "coverage");
    expect(covCheck?.passed).toBe(true);
    expect(covCheck?.detail).toContain("90%");
  });

  // -----------------------------------------------------------------------
  // 2. Fails when test command fails
  // -----------------------------------------------------------------------
  it("fails when test command returns non-zero exit code", async () => {
    const config = makeConfig({
      test_command: "npm test",
      lint_command: "",
      require_test_files: false,
    });

    runCommand.mockReturnValue(failResult(1));

    const result = await checkGate0Exit("1.1.1", config, "/project");

    expect(result.passed).toBe(false);

    const testCheck = result.checks.find((c) => c.name === "tests");
    expect(testCheck?.passed).toBe(false);
    expect(testCheck?.detail).toContain("exit code 1");
  });

  // -----------------------------------------------------------------------
  // 3. Fails when coverage is below threshold
  // -----------------------------------------------------------------------
  it("fails when coverage is below threshold", async () => {
    const config = makeConfig({
      test_command: "npm test",
      lint_command: "",
      coverage_threshold: 85,
      require_test_files: false,
    });

    runCommand.mockReturnValue(okResult("Statements : 70%"));
    parseCoverage.mockReturnValue(70);

    const result = await checkGate0Exit("1.1.1", config, "/project");

    expect(result.passed).toBe(false);
    expect(result.coverage).toBe(70);

    const covCheck = result.checks.find((c) => c.name === "coverage");
    expect(covCheck?.passed).toBe(false);
    expect(covCheck?.detail).toContain("70%");
    expect(covCheck?.detail).toContain("85%");
  });

  // -----------------------------------------------------------------------
  // 4. Fails when lint command fails
  // -----------------------------------------------------------------------
  it("fails when lint command returns non-zero exit code", async () => {
    const config = makeConfig({
      test_command: "",
      lint_command: "npm run lint",
      require_test_files: false,
    });

    runCommand.mockReturnValue(failResult(2));

    const result = await checkGate0Exit("1.1.1", config, "/project");

    expect(result.passed).toBe(false);

    const lintCheck = result.checks.find((c) => c.name === "lint");
    expect(lintCheck?.passed).toBe(false);
    expect(lintCheck?.detail).toContain("exit code 2");
  });

  // -----------------------------------------------------------------------
  // 5. Passes trivially when no commands are configured
  // -----------------------------------------------------------------------
  it("passes trivially when no commands are configured", async () => {
    const config = makeConfig({
      test_command: "",
      lint_command: "",
      require_test_files: false,
    });

    const result = await checkGate0Exit("1.1.1", config, "/project");

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].detail).toContain("trivially");
  });

  // -----------------------------------------------------------------------
  // 6. Coverage check skipped when tests fail
  // -----------------------------------------------------------------------
  it("does not run coverage check when tests fail", async () => {
    const config = makeConfig({
      test_command: "npm test",
      lint_command: "",
      coverage_threshold: 80,
      require_test_files: false,
    });

    runCommand.mockReturnValue(failResult(1));

    const result = await checkGate0Exit("1.1.1", config, "/project");

    expect(result.passed).toBe(false);

    const covCheck = result.checks.find((c) => c.name === "coverage");
    expect(covCheck).toBeUndefined();

    expect(parseCoverage).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 7. Coverage not parseable — passes with info note
  // -----------------------------------------------------------------------
  it("passes coverage check when coverage cannot be parsed", async () => {
    const config = makeConfig({
      test_command: "npm test",
      lint_command: "",
      coverage_threshold: 80,
      require_test_files: false,
    });

    runCommand.mockReturnValue(okResult("no coverage info here"));
    parseCoverage.mockReturnValue(null);

    const result = await checkGate0Exit("1.1.1", config, "/project");

    expect(result.passed).toBe(true);

    const covCheck = result.checks.find((c) => c.name === "coverage");
    expect(covCheck?.passed).toBe(true);
    expect(covCheck?.detail).toContain("not available");
  });

  // -----------------------------------------------------------------------
  // 8. test_files check is informational
  // -----------------------------------------------------------------------
  it("records test_files as informational pass when enabled", async () => {
    const config = makeConfig({
      test_command: "",
      lint_command: "npm run lint",
      require_test_files: true,
    });

    runCommand.mockReturnValue(okResult());

    const result = await checkGate0Exit("1.1.1", config, "/project");

    const tfCheck = result.checks.find((c) => c.name === "test_files");
    expect(tfCheck?.passed).toBe(true);
    expect(tfCheck?.detail).toContain("Phase 4");
  });
});
