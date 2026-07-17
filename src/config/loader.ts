/**
 * Config loader — reads .rigor/config.yaml and deep-merges with DEFAULTS.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { DEFAULTS } from "./schema.js";
import type { RigorConfig } from "./schema.js";

// ---------------------------------------------------------------------------
// Deep merge helper
// ---------------------------------------------------------------------------

/**
 * Deep-merge `source` into `target`.
 *
 * - Plain objects are merged recursively.
 * - Arrays from source **replace** target arrays entirely (no concat).
 * - Primitives from source override target.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];

    if (isPlainObject(srcVal) && isPlainObject(tgtVal)) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const CONFIG_DIR = ".rigor";
const CONFIG_FILE = "config.yaml";

/**
 * Load Rigor configuration from `<projectRoot>/.rigor/config.yaml`.
 *
 * - If the file does not exist, returns {@link DEFAULTS}.
 * - If the file exists, deep-merges its values over DEFAULTS (arrays replace,
 *   objects merge, primitives override).
 * - If YAML parsing fails, throws with a descriptive message.
 */
export function loadConfig(projectRoot: string): RigorConfig {
  const configPath = join(projectRoot, CONFIG_DIR, CONFIG_FILE);

  if (!existsSync(configPath)) {
    return structuredClone(DEFAULTS);
  }

  const raw = readFileSync(configPath, "utf-8");

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (cause: unknown) {
    const message =
      cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Failed to parse YAML config at ${configPath}: ${message}`,
    );
  }

  // An empty file or a file with only comments parses to null.
  if (parsed === null || parsed === undefined) {
    return structuredClone(DEFAULTS);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(
      `Invalid config at ${configPath}: expected an object, got ${typeof parsed}`,
    );
  }

  // Safe assertion: the merge target starts as a full RigorConfig clone
  // (structuredClone of DEFAULTS). deepMerge only overrides matching keys
  // from user YAML, so the result retains the complete RigorConfig shape.
  const merged = deepMerge(
    structuredClone(DEFAULTS) as unknown as Record<string, unknown>,
    parsed,
  );
  return merged as unknown as RigorConfig;
}
