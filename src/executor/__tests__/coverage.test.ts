import { describe, it, expect } from "vitest";
import { parseCoverage, parseMetric } from "../coverage.js";

describe("parseCoverage", () => {
  // -----------------------------------------------------------------------
  // Go format
  // -----------------------------------------------------------------------
  describe("go format", () => {
    it("parses Go coverage from go tool cover output", () => {
      const output = [
        "github.com/org/repo/pkg/foo.go:12:\tFoo\t\t100.0%",
        "github.com/org/repo/pkg/bar.go:5:\tBar\t\t60.0%",
        "total:\t(statements)\t78.5%",
      ].join("\n");

      expect(parseCoverage(output, "go")).toBe(78.5);
    });

    it("returns null when Go total line is absent", () => {
      expect(parseCoverage("no coverage here", "go")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Jest / Vitest format
  // -----------------------------------------------------------------------
  describe("jest format", () => {
    it("parses the All files summary row", () => {
      const output = [
        "----------|---------|----------|---------|---------|",
        "File      | % Stmts | % Branch | % Funcs | % Lines |",
        "----------|---------|----------|---------|---------|",
        "All files |   85.71 |      100 |      75 |   85.71 |",
        "----------|---------|----------|---------|---------|",
      ].join("\n");

      expect(parseCoverage(output, "jest")).toBe(85.71);
    });

    it("parses Statements percentage line", () => {
      const output = "Statements   : 92.3% ( 12/13 )";
      expect(parseCoverage(output, "jest")).toBe(92.3);
    });

    it("returns null when neither pattern matches", () => {
      expect(parseCoverage("no jest output here", "jest")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // lcov / Istanbul format
  // -----------------------------------------------------------------------
  describe("lcov format", () => {
    it("parses lcov/Istanbul text summary", () => {
      const output = [
        "Statements   : 85.71% ( 12/14 )",
        "Branches     : 100% ( 4/4 )",
        "Functions    : 75% ( 3/4 )",
        "Lines        : 85.71% ( 12/14 )",
      ].join("\n");

      expect(parseCoverage(output, "lcov")).toBe(85.71);
    });
  });

  // -----------------------------------------------------------------------
  // Auto format
  // -----------------------------------------------------------------------
  describe("auto format", () => {
    it("detects Go format automatically", () => {
      const output = "total:\t(statements)\t78.5%";
      expect(parseCoverage(output)).toBe(78.5);
    });

    it("detects Jest format automatically", () => {
      const output = "All files  |   85.71 |    100 |     75 |   85.71 |";
      expect(parseCoverage(output)).toBe(85.71);
    });

    it("falls back to generic for unknown format", () => {
      expect(parseCoverage("Coverage: 90%")).toBe(90);
    });

    it("returns null when output has no percentage at all", () => {
      expect(parseCoverage("nothing useful here")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Generic fallback — takes the last percentage
  // -----------------------------------------------------------------------
  describe("generic fallback", () => {
    it("extracts the last percentage in the output", () => {
      const output = "Step 1: 50% done\nStep 2: 75% done\nFinal: 95%";
      expect(parseCoverage(output, "auto")).toBe(95);
    });

    it("handles integer percentages", () => {
      expect(parseCoverage("Coverage: 100%")).toBe(100);
    });
  });
});

// ---------------------------------------------------------------------------
// parseMetric
// ---------------------------------------------------------------------------

describe("parseMetric", () => {
  it("extracts a float from a capture group", () => {
    const output = "Quality Score: 92.5 / 100";
    expect(parseMetric(output, "Score:\\s+(\\d+\\.?\\d*)")).toBe(92.5);
  });

  it("extracts an integer value", () => {
    const output = "Complexity: 42";
    expect(parseMetric(output, "Complexity:\\s+(\\d+)")).toBe(42);
  });

  it("returns null when pattern does not match", () => {
    expect(parseMetric("no match here", "Score:\\s+(\\d+)")).toBeNull();
  });

  it("returns null for an invalid regex pattern", () => {
    expect(parseMetric("test", "[invalid(")).toBeNull();
  });

  it("returns null when capture group is missing", () => {
    // Regex matches but has no capture group
    expect(parseMetric("Score: 90", "Score: \\d+")).toBeNull();
  });

  it("uses multiline mode to match across lines", () => {
    const output = "Line 1\nResult: 88.3\nLine 3";
    expect(parseMetric(output, "Result:\\s+(\\d+\\.?\\d*)")).toBe(88.3);
  });
});
