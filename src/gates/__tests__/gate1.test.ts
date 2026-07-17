/**
 * Tests for Gate 1 infrastructure check logic.
 *
 * Uses temp directories for file system operations and mocks the executor
 * module to avoid running real shell commands.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RigorConfig } from "../../config/index.js";
import { DEFAULTS } from "../../config/index.js";
import type { CommandResult } from "../../executor/index.js";

// ---------------------------------------------------------------------------
// Mock the executor
// ---------------------------------------------------------------------------

vi.mock("../../executor/index.js", () => ({
  runCommand: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const { runCommand } = await import("../../executor/index.js") as {
  runCommand: ReturnType<typeof vi.fn>;
};

const { checkGate1Exit, detectDependencyChanges, saveBaseline } = await import("../gate1.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<RigorConfig["gates"]["gate_1"]>): RigorConfig {
  return {
    ...DEFAULTS,
    gates: {
      ...DEFAULTS.gates,
      gate_1: {
        ...DEFAULTS.gates.gate_1,
        ...overrides,
      },
    },
  };
}

function okResult(stdout: string = ""): CommandResult {
  return {
    command: "npm audit",
    exit_code: 0,
    stdout,
    stderr: "",
    duration_ms: 100,
    timed_out: false,
  };
}

function failResult(exitCode: number = 1): CommandResult {
  return {
    command: "npm audit",
    exit_code: exitCode,
    stdout: "",
    stderr: "audit error",
    duration_ms: 50,
    timed_out: false,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Gate 1 — infrastructure check", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), "rigor-gate1-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 1. Gate 1 disabled → skipped, passed
  // -----------------------------------------------------------------------
  it("returns skipped and passed when Gate 1 is disabled", () => {
    const config = makeConfig({ enabled: false });

    const result = checkGate1Exit(config, tempDir);

    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].name).toBe("gate_1");
    expect(result.checks[0].detail).toContain("disabled");
  });

  // -----------------------------------------------------------------------
  // 2. No baseline exists → creates baseline, returns skipped
  // -----------------------------------------------------------------------
  it("creates baseline and returns skipped when no baseline exists", () => {
    const config = makeConfig({ enabled: true });

    // Create a package.json in the temp dir so there's something to hash
    writeFileSync(join(tempDir, "package.json"), '{ "name": "test" }');

    const result = checkGate1Exit(config, tempDir);

    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.checks[0].detail).toContain("No dependency changes");

    // Baseline file should have been created
    const baselinePath = join(tempDir, ".rigor/baselines/deps.json");
    expect(existsSync(baselinePath)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 3. Unchanged dependencies → returns skipped
  // -----------------------------------------------------------------------
  it("returns skipped when dependencies have not changed", () => {
    const config = makeConfig({ enabled: true });

    writeFileSync(join(tempDir, "package.json"), '{ "name": "test" }');

    // Create a baseline first
    saveBaseline(tempDir);

    const result = checkGate1Exit(config, tempDir);

    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.checks[0].detail).toContain("No dependency changes");
  });

  // -----------------------------------------------------------------------
  // 4. Changed package.json → detects change, returns changedFiles
  // -----------------------------------------------------------------------
  it("detects changed package.json", () => {
    writeFileSync(join(tempDir, "package.json"), '{ "name": "test" }');

    // Create baseline with original content
    saveBaseline(tempDir);

    // Modify package.json
    writeFileSync(join(tempDir, "package.json"), '{ "name": "test", "version": "2.0.0" }');

    const { changed, changedFiles } = detectDependencyChanges(tempDir);

    expect(changed).toBe(true);
    expect(changedFiles).toContain("package.json");
  });

  // -----------------------------------------------------------------------
  // 5. Audit command passes → returns passed with audit check
  // -----------------------------------------------------------------------
  it("returns passed when audit command succeeds", () => {
    const config = makeConfig({ enabled: true, audit_command: "npm audit" });

    writeFileSync(join(tempDir, "package.json"), '{ "name": "test" }');
    saveBaseline(tempDir);

    // Modify to trigger change
    writeFileSync(join(tempDir, "package.json"), '{ "name": "test-changed" }');

    runCommand.mockReturnValue(okResult());

    const result = checkGate1Exit(config, tempDir);

    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(false);

    const auditCheck = result.checks.find((c) => c.name === "audit");
    expect(auditCheck?.passed).toBe(true);
    expect(auditCheck?.detail).toContain("audit passed");

    const depCheck = result.checks.find((c) => c.name === "dependency_changes");
    expect(depCheck?.passed).toBe(true);
    expect(depCheck?.detail).toContain("package.json");
  });

  // -----------------------------------------------------------------------
  // 6. Audit command fails → returns failed with audit check
  // -----------------------------------------------------------------------
  it("returns failed when audit command fails", () => {
    const config = makeConfig({ enabled: true, audit_command: "npm audit" });

    writeFileSync(join(tempDir, "package.json"), '{ "name": "test" }');
    saveBaseline(tempDir);

    // Modify to trigger change
    writeFileSync(join(tempDir, "package.json"), '{ "name": "test-changed" }');

    runCommand.mockReturnValue(failResult(1));

    const result = checkGate1Exit(config, tempDir);

    expect(result.passed).toBe(false);
    expect(result.skipped).toBe(false);

    const auditCheck = result.checks.find((c) => c.name === "audit");
    expect(auditCheck?.passed).toBe(false);
    expect(auditCheck?.detail).toContain("failed");
    expect(auditCheck?.detail).toContain("exit code 1");
  });

  // -----------------------------------------------------------------------
  // 7. Baseline updated after successful check
  // -----------------------------------------------------------------------
  it("updates baseline after successful audit", () => {
    const config = makeConfig({ enabled: true, audit_command: "npm audit" });

    writeFileSync(join(tempDir, "package.json"), '{ "name": "v1" }');
    saveBaseline(tempDir);

    // Modify to trigger change
    writeFileSync(join(tempDir, "package.json"), '{ "name": "v2" }');

    runCommand.mockReturnValue(okResult());

    checkGate1Exit(config, tempDir);

    // Baseline should now reflect the v2 content — a second run should see no changes
    const { changed } = detectDependencyChanges(tempDir);
    expect(changed).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 8. Baseline NOT updated after failed check
  // -----------------------------------------------------------------------
  it("does not update baseline after failed audit", () => {
    const config = makeConfig({ enabled: true, audit_command: "npm audit" });

    writeFileSync(join(tempDir, "package.json"), '{ "name": "v1" }');
    saveBaseline(tempDir);

    // Modify to trigger change
    writeFileSync(join(tempDir, "package.json"), '{ "name": "v2" }');

    runCommand.mockReturnValue(failResult(1));

    checkGate1Exit(config, tempDir);

    // Baseline should still reference v1, so changes are still detected
    const { changed } = detectDependencyChanges(tempDir);
    expect(changed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 9. Detects removed dependency files
  // -----------------------------------------------------------------------
  it("detects removed dependency files", () => {
    writeFileSync(join(tempDir, "package.json"), '{ "name": "test" }');
    writeFileSync(join(tempDir, "go.mod"), "module example.com/test");

    saveBaseline(tempDir);

    // Remove go.mod
    rmSync(join(tempDir, "go.mod"));

    const { changed, changedFiles } = detectDependencyChanges(tempDir);

    expect(changed).toBe(true);
    expect(changedFiles).toContain("go.mod");
  });

  // -----------------------------------------------------------------------
  // 10. Detects newly added dependency files
  // -----------------------------------------------------------------------
  it("detects newly added dependency files", () => {
    writeFileSync(join(tempDir, "package.json"), '{ "name": "test" }');

    saveBaseline(tempDir);

    // Add a new dep file
    writeFileSync(join(tempDir, "go.mod"), "module example.com/test");

    const { changed, changedFiles } = detectDependencyChanges(tempDir);

    expect(changed).toBe(true);
    expect(changedFiles).toContain("go.mod");
  });

  // -----------------------------------------------------------------------
  // 11. No audit command configured → still passes on dependency change
  // -----------------------------------------------------------------------
  it("passes with no audit command when dependencies change", () => {
    const config = makeConfig({ enabled: true, audit_command: "" });

    writeFileSync(join(tempDir, "package.json"), '{ "name": "v1" }');
    saveBaseline(tempDir);

    writeFileSync(join(tempDir, "package.json"), '{ "name": "v2" }');

    const result = checkGate1Exit(config, tempDir);

    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].name).toBe("dependency_changes");
    expect(runCommand).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 12. Corrupted baseline → treated as no baseline (creates new one)
  // -----------------------------------------------------------------------
  it("handles corrupted baseline file gracefully", () => {
    const config = makeConfig({ enabled: true });

    writeFileSync(join(tempDir, "package.json"), '{ "name": "test" }');

    // Create a corrupted baseline
    const dir = join(tempDir, ".rigor/baselines");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "deps.json"), "not valid json {{{");

    const result = checkGate1Exit(config, tempDir);

    // Should treat as first run (no baseline) → skipped
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);

    // Should have created a valid baseline
    const baselineContent = readFileSync(join(dir, "deps.json"), "utf-8");
    const parsed = JSON.parse(baselineContent);
    expect(parsed.hashes).toBeDefined();
    expect(parsed.created_at).toBeDefined();
  });
});
