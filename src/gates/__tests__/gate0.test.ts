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

  // -----------------------------------------------------------------------
  // 9. Design-quality check passes
  // -----------------------------------------------------------------------
  it("passes design-quality check when command exits 0", async () => {
    const config = makeConfig({
      test_command: "",
      lint_command: "",
      design_command: "echo 'No issues found'",
      require_test_files: false,
    });

    runCommand.mockReturnValue(okResult("No issues found"));

    const result = await checkGate0Exit("1.1.1", config, "/project");

    expect(result.passed).toBe(true);

    const designCheck = result.checks.find((c) => c.name === "design-quality");
    expect(designCheck?.passed).toBe(true);
    expect(designCheck?.detail).toContain("Design quality check passed");
  });

  // -----------------------------------------------------------------------
  // 10. Design-quality check fails with violations
  // -----------------------------------------------------------------------
  it("fails design-quality check when command exits 1 with findings", async () => {
    const config = makeConfig({
      test_command: "",
      lint_command: "",
      design_command: "npx impeccable detect src/",
      require_test_files: false,
    });

    runCommand.mockReturnValue({
      command: "npx impeccable detect src/",
      exit_code: 1,
      stdout: "P0: overused-font in src/Button.tsx:5",
      stderr: "",
      duration_ms: 200,
      timed_out: false,
    });

    const result = await checkGate0Exit("1.1.1", config, "/project");

    expect(result.passed).toBe(false);

    const designCheck = result.checks.find((c) => c.name === "design-quality");
    expect(designCheck?.passed).toBe(false);
    expect(designCheck?.detail).toContain("P0: overused-font in src/Button.tsx:5");
  });

  // -----------------------------------------------------------------------
  // 11. Design-quality check skipped when command is empty
  // -----------------------------------------------------------------------
  it("skips design-quality check when design_command is empty", async () => {
    const config = makeConfig({
      test_command: "npm test",
      lint_command: "",
      design_command: "",
      require_test_files: false,
    });

    runCommand.mockReturnValue(okResult("Statements : 90%"));
    parseCoverage.mockReturnValue(90);

    const result = await checkGate0Exit("1.1.1", config, "/project");

    const designCheck = result.checks.find((c) => c.name === "design-quality");
    expect(designCheck).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // 12. Design-quality check with command not found (exit 127)
  // -----------------------------------------------------------------------
  it("reports command not found when design command exits 127", async () => {
    const config = makeConfig({
      test_command: "",
      lint_command: "",
      design_command: "npx impeccable detect src/",
      require_test_files: false,
    });

    runCommand.mockReturnValue({
      command: "npx impeccable detect src/",
      exit_code: 127,
      stdout: "",
      stderr: "npx: command 'impeccable' not found",
      duration_ms: 50,
      timed_out: false,
    });

    const result = await checkGate0Exit("1.1.1", config, "/project");

    expect(result.passed).toBe(false);

    const designCheck = result.checks.find((c) => c.name === "design-quality");
    expect(designCheck?.passed).toBe(false);
    expect(designCheck?.detail).toContain("Command not found");
    expect(designCheck?.detail).toContain("npx impeccable detect src/");
    expect(designCheck?.exit_code).toBe(127);
  });

  // -----------------------------------------------------------------------
  // 13. Lint command not found (exit 127) reports clear message
  // -----------------------------------------------------------------------
  it("reports command not found when lint command exits 127", async () => {
    const config = makeConfig({
      test_command: "",
      lint_command: "npx eslint .",
      require_test_files: false,
    });

    runCommand.mockReturnValue({
      command: "npx eslint .",
      exit_code: 127,
      stdout: "",
      stderr: "bash: eslint: command not found",
      duration_ms: 30,
      timed_out: false,
    });

    const result = await checkGate0Exit("1.1.1", config, "/project");

    expect(result.passed).toBe(false);

    const lintCheck = result.checks.find((c) => c.name === "lint");
    expect(lintCheck?.passed).toBe(false);
    expect(lintCheck?.detail).toContain("Command not found");
    expect(lintCheck?.detail).toContain("npx eslint .");
    expect(lintCheck?.exit_code).toBe(127);
  });

  // -----------------------------------------------------------------------
  // 14. Test command not found (exit 127) reports clear message
  // -----------------------------------------------------------------------
  it("reports command not found when test command exits 127", async () => {
    const config = makeConfig({
      test_command: "npx vitest run",
      lint_command: "",
      require_test_files: false,
    });

    runCommand.mockReturnValue({
      command: "npx vitest run",
      exit_code: 127,
      stdout: "",
      stderr: "bash: vitest: command not found",
      duration_ms: 30,
      timed_out: false,
    });

    const result = await checkGate0Exit("1.1.1", config, "/project");

    expect(result.passed).toBe(false);

    const testCheck = result.checks.find((c) => c.name === "tests");
    expect(testCheck?.passed).toBe(false);
    expect(testCheck?.detail).toContain("Command not found");
    expect(testCheck?.detail).toContain("npx vitest run");
    expect(testCheck?.exit_code).toBe(127);

    // Coverage check should NOT run when test command not found
    const covCheck = result.checks.find((c) => c.name === "coverage");
    expect(covCheck).toBeUndefined();
    expect(parseCoverage).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 15. Gate 0 passes trivially when all three commands are empty
  // -----------------------------------------------------------------------
  it("passes trivially when test, lint, and design commands are all empty", async () => {
    const config = makeConfig({
      test_command: "",
      lint_command: "",
      design_command: "",
      require_test_files: false,
    });

    const result = await checkGate0Exit("1.1.1", config, "/project");

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].detail).toContain("trivially");
  });

  // -----------------------------------------------------------------------
  // 16. Design-quality check runs alongside tests and lint
  // -----------------------------------------------------------------------
  it("runs design-quality check alongside tests and lint", async () => {
    const config = makeConfig({
      test_command: "npm test",
      lint_command: "npm run lint",
      design_command: "npx impeccable detect src/",
      require_test_files: false,
    });

    // All three commands succeed
    runCommand.mockReturnValue(okResult("all good"));
    parseCoverage.mockReturnValue(null);

    const result = await checkGate0Exit("1.1.1", config, "/project");

    expect(result.passed).toBe(true);

    const testCheck = result.checks.find((c) => c.name === "tests");
    expect(testCheck?.passed).toBe(true);

    const lintCheck = result.checks.find((c) => c.name === "lint");
    expect(lintCheck?.passed).toBe(true);

    const designCheck = result.checks.find((c) => c.name === "design-quality");
    expect(designCheck?.passed).toBe(true);
  });
});
