/**
 * Coverage parser — extracts a coverage percentage from tool output.
 *
 * Supports Go (`go tool cover`), Jest/Vitest table output, lcov/Istanbul
 * text summaries, and a generic fallback that grabs the last `N%` match.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CoverageFormat = "go" | "jest" | "lcov" | "auto";

// ---------------------------------------------------------------------------
// Format-specific parsers
// ---------------------------------------------------------------------------

/**
 * Go: `go tool cover -func` emits a final line like
 *   `total:    (statements)    78.5%`
 */
function parseGo(output: string): number | null {
  const match = output.match(/^total:\s.*?(\d+\.?\d*)%/m);
  return match ? Number(match[1]) : null;
}

/**
 * Jest / Vitest: table output contains an "All files" summary row:
 *   `All files  |   85.71 |    100 |     75 |   85.71 |`
 *
 * Or a Statements summary:
 *   `Statements   : 85.71%`
 */
function parseJest(output: string): number | null {
  // Try "Statements : N%" first (also covers Istanbul text).
  const stmtMatch = output.match(/Statements\s*:\s*(\d+\.?\d*)%/i);
  if (stmtMatch) return Number(stmtMatch[1]);

  // Fall back to the "All files" table row — first numeric column is
  // statement coverage.
  const allFilesMatch = output.match(
    /All files\s*\|\s*(\d+\.?\d*)/,
  );
  if (allFilesMatch) return Number(allFilesMatch[1]);

  return null;
}

/**
 * lcov / Istanbul text summary:
 *   `Statements   : 85.71% ( 12/14 )`
 */
function parseLcov(output: string): number | null {
  const match = output.match(/Statements\s*:\s*(\d+\.?\d*)%/i);
  return match ? Number(match[1]) : null;
}

/**
 * Generic fallback: grab the *last* percentage pattern in the output.
 */
function parseGeneric(output: string): number | null {
  const matches = [...output.matchAll(/(\d+\.?\d*)%/g)];
  if (matches.length === 0) return null;
  return Number(matches[matches.length - 1][1]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract a coverage percentage from command output.
 *
 * @param output  Raw stdout/stderr from a coverage tool.
 * @param format  Hint for which parser to use. Defaults to `"auto"` which
 *                tries each format in order: go, jest, lcov, generic.
 * @returns The coverage percentage (e.g. `85.71`), or `null` when no
 *          coverage data is found.
 */
export function parseCoverage(
  output: string,
  format: CoverageFormat = "auto",
): number | null {
  if (format === "go") return parseGo(output);
  if (format === "jest") return parseJest(output);
  if (format === "lcov") return parseLcov(output);

  // Auto: try all parsers in order.
  return parseGo(output) ?? parseJest(output) ?? parseLcov(output) ?? parseGeneric(output);
}
