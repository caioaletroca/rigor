/**
 * Tests for Gate 0 exit-criteria logic.
 *
 * Mocks the executor module to avoid running real shell commands.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RigorConfig } from "../../config/index.js";
import { DEFAULTS } from "../../config/index.js";
import { migrateGate0Config } from "../../config/loader.js";
import type { CommandResult } from "../../executor/index.js";

// ---------------------------------------------------------------------------
// Mock the executor
// ---------------------------------------------------------------------------

vi.mock("../../executor/index.js", () => ({
  runCommand: vi.fn(),
  parseCoverage: vi.fn(),
  parseMetric: vi.fn(),
}));

// Import AFTER mock setup so the module picks up the mock.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const { runCommand } = await import("../../executor/index.js") as {
  runCommand: ReturnType<typeof vi.fn>;
  parseCoverage: ReturnType<typeof vi.fn>;
  parseMetric: ReturnType<typeof vi.fn>;
};
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const { parseCoverage, parseMetric } = await import("../../executor/index.js") as {
  parseCoverage: ReturnType<typeof vi.fn>;
  parseMetric: ReturnType<typeof vi.fn>;
};

const { checkGate0Exit } = await import("../gate0.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a RigorConfig with Gate 0 overrides. Calls migrateGate0Config to
 * convert legacy fields into checks[], matching the production code path.
 */
function makeConfig(overrides?: Partial<RigorConfig["gates"]["gate_0"]>): RigorConfig {
  const config: RigorConfig = {
    ...DEFAULTS,
    gates: {
      ...DEFAULTS.gates,
      gate_0: {
        ...DEFAULTS.gates.gate_0,
        ...overrides,
      },
    },
  };
  migrateGate0Config(config);
  return config;
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

  // =======================================================================
  // Generic checks[] tests
  // =======================================================================

  // -----------------------------------------------------------------------
  // 9. Generic check with custom metric passes when above threshold
  // -----------------------------------------------------------------------
  it("passes generic check with custom metric above threshold", async () => {
    const config = makeConfig({
      test_command: "",
      lint_command: "",
      require_test_files: false,
      checks: [
        {
          name: "quality",
          command: "run-quality-check",
          metric: {
            parse: "Score:\\s+(\\d+\\.?\\d*)",
            threshold: 80,
            label: "score",
          },
        },
      ],
    });

    runCommand.mockReturnValue(okResult("Score: 92.5"));
    parseMetric.mockReturnValue(92.5);

    const result = await checkGate0Exit("1.1.1", config, "/project");

    expect(result.passed).toBe(true);

    const qualityCheck = result.checks.find((c) => c.name === "quality");
    expect(qualityCheck?.passed).toBe(true);

    const scoreCheck = result.checks.find((c) => c.name === "score");
    expect(scoreCheck?.passed).toBe(true);
    expect(scoreCheck?.detail).toContain("92.5%");
    expect(scoreCheck?.detail).toContain("80%");
  });

  // -----------------------------------------------------------------------
  // 10. Generic check with custom metric fails when below threshold
  // -----------------------------------------------------------------------
  it("fails generic check with custom metric below threshold", async () => {
    const config = makeConfig({
      test_command: "",
      lint_command: "",
      require_test_files: false,
      checks: [
        {
          name: "quality",
          command: "run-quality-check",
          metric: {
            parse: "Score:\\s+(\\d+\\.?\\d*)",
            threshold: 80,
            label: "score",
          },
        },
      ],
    });

    runCommand.mockReturnValue(okResult("Score: 55"));
    parseMetric.mockReturnValue(55);

    const result = await checkGate0Exit("1.1.1", config, "/project");

    expect(result.passed).toBe(false);

    const scoreCheck = result.checks.find((c) => c.name === "score");
    expect(scoreCheck?.passed).toBe(false);
    expect(scoreCheck?.detail).toContain("55%");
    expect(scoreCheck?.detail).toContain("80%");
  });

  // -----------------------------------------------------------------------
  // 11. Command-only check (no metric) passes on exit 0
  // -----------------------------------------------------------------------
  it("passes command-only check with no metric when exit code is 0", async () => {
    const config = makeConfig({
      test_command: "",
      lint_command: "",
      require_test_files: false,
      checks: [
        { name: "typecheck", command: "npx tsc --noEmit" },
      ],
    });

    runCommand.mockReturnValue(okResult());

    const result = await checkGate0Exit("1.1.1", config, "/project");

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].name).toBe("typecheck");
    expect(result.checks[0].passed).toBe(true);
    expect(result.checks[0].detail).toContain("Typecheck passed");
  });

  // -----------------------------------------------------------------------
  // 12. Command-only check (no metric) fails on non-zero exit
  // -----------------------------------------------------------------------
  it("fails command-only check with no metric when exit code is non-zero", async () => {
    const config = makeConfig({
      test_command: "",
      lint_command: "",
      require_test_files: false,
      checks: [
        { name: "typecheck", command: "npx tsc --noEmit" },
      ],
    });

    runCommand.mockReturnValue(failResult(2));

    const result = await checkGate0Exit("1.1.1", config, "/project");

    expect(result.passed).toBe(false);
    expect(result.checks[0].name).toBe("typecheck");
    expect(result.checks[0].passed).toBe(false);
    expect(result.checks[0].detail).toContain("exit code 2");
  });

  // -----------------------------------------------------------------------
  // 13. Empty checks array passes trivially
  // -----------------------------------------------------------------------
  it("passes trivially when checks array is empty", async () => {
    const config = makeConfig({
      test_command: "",
      lint_command: "",
      require_test_files: false,
      checks: [],
    });

    const result = await checkGate0Exit("1.1.1", config, "/project");

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].detail).toContain("trivially");
    expect(runCommand).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 14. Old-format config migrated via migrateGate0Config works correctly
  // -----------------------------------------------------------------------
  it("handles old-format config migrated through migrateGate0Config", async () => {
    // makeConfig already calls migrateGate0Config, so this tests the
    // full backward-compat pipeline with both test and lint commands.
    const config = makeConfig({
      test_command: "jest --coverage",
      lint_command: "eslint .",
      coverage_threshold: 90,
      require_test_files: false,
    });

    // Should have been migrated to 2 checks
    expect(config.gates.gate_0.checks).toHaveLength(2);
    expect(config.gates.gate_0.checks[0].name).toBe("tests");
    expect(config.gates.gate_0.checks[0].metric?.label).toBe("coverage");
    expect(config.gates.gate_0.checks[0].metric?.threshold).toBe(90);
    expect(config.gates.gate_0.checks[1].name).toBe("lint");

    // Now run it through the gate
    runCommand
      .mockReturnValueOnce(okResult("Statements : 95%"))  // tests
      .mockReturnValueOnce(okResult());                     // lint
    parseCoverage.mockReturnValue(95);

    const result = await checkGate0Exit("1.1.1", config, "/project");

    expect(result.passed).toBe(true);
    expect(result.coverage).toBe(95);

    const testCheck = result.checks.find((c) => c.name === "tests");
    expect(testCheck?.passed).toBe(true);

    const covCheck = result.checks.find((c) => c.name === "coverage");
    expect(covCheck?.passed).toBe(true);

    const lintCheck = result.checks.find((c) => c.name === "lint");
    expect(lintCheck?.passed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 15. Evidence includes metric labels, parsed values, and thresholds
  // -----------------------------------------------------------------------
  it("produces evidence-compatible checks with metric data", async () => {
    const config = makeConfig({
      test_command: "",
      lint_command: "",
      require_test_files: false,
      checks: [
        {
          name: "perf",
          command: "lighthouse-ci",
          metric: {
            parse: "Performance:\\s+(\\d+)",
            threshold: 90,
            label: "performance",
          },
        },
      ],
    });

    runCommand.mockReturnValue(okResult("Performance: 95"));
    parseMetric.mockReturnValue(95);

    const result = await checkGate0Exit("1.1.1", config, "/project");

    // The checks array is what gets saved to evidence JSON.
    // Verify it contains the metric label as a check name,
    // with the parsed value and threshold in the detail.
    const perfCommand = result.checks.find((c) => c.name === "perf");
    expect(perfCommand).toBeDefined();
    expect(perfCommand?.command).toBe("lighthouse-ci");
    expect(perfCommand?.exit_code).toBe(0);
    expect(perfCommand?.duration_ms).toBeDefined();

    const metricCheck = result.checks.find((c) => c.name === "performance");
    expect(metricCheck).toBeDefined();
    expect(metricCheck?.passed).toBe(true);
    expect(metricCheck?.detail).toContain("95%");
    expect(metricCheck?.detail).toContain("90%");
    expect(metricCheck?.detail).toContain("Performance");
  });
});
