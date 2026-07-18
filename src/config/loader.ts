/**
 * Config loader — reads .rigor/config.yaml and deep-merges with DEFAULTS.
 *
 * Merge cascade: core DEFAULTS → domain pack defaults → user config.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { DEFAULTS } from "./schema.js";
import type { RigorConfig, Check } from "./schema.js";

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
// Gate 0 backward-compat migration
// ---------------------------------------------------------------------------

/**
 * Convert legacy `test_command` / `lint_command` / `coverage_threshold` fields
 * into the generic `checks[]` array when `checks` is empty.
 *
 * This allows old-format configs to work transparently with the new
 * generic check runner.
 */
export function migrateGate0Config(config: RigorConfig): void {
  const g0 = config.gates.gate_0;

  // If checks are already populated, the user is using the new format.
  if (g0.checks.length > 0) return;

  const checks: Check[] = [];

  if (g0.test_command !== "") {
    const check: Check = { name: "tests", command: g0.test_command };

    if (g0.coverage_threshold > 0) {
      check.metric = {
        parse: "auto",
        threshold: g0.coverage_threshold,
        label: "coverage",
      };
    }

    checks.push(check);
  }

  if (g0.lint_command !== "") {
    checks.push({ name: "lint", command: g0.lint_command });
  }

  g0.checks = checks;
}

// ---------------------------------------------------------------------------
// Domain pack loading
// ---------------------------------------------------------------------------

/**
 * Resolve the path to a domain pack's `defaults.yaml`.
 *
 * Searches in order:
 * 1. `<projectRoot>/skills/domain/<domain>/defaults.yaml`
 * 2. `<rigorPackageRoot>/skills/domain/<domain>/defaults.yaml`
 *
 * Returns the first existing path, or `null` if not found.
 */
function resolveDomainPackPath(
  domain: string,
  projectRoot: string,
): string | null {
  // 1. Project-local domain packs
  const projectPath = join(projectRoot, "skills", "domain", domain, "defaults.yaml");
  if (existsSync(projectPath)) return projectPath;

  // 2. Rigor package's built-in domain packs
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const builtinPath = join(packageRoot, "skills", "domain", domain, "defaults.yaml");
  if (existsSync(builtinPath)) return builtinPath;

  return null;
}

/**
 * Load a domain pack's defaults.yaml and return the parsed object.
 * Returns `null` if the domain pack does not exist or is empty.
 */
export function loadDomainPackDefaults(
  domain: string,
  projectRoot: string,
): Record<string, unknown> | null {
  const packPath = resolveDomainPackPath(domain, projectRoot);
  if (!packPath) return null;

  const raw = readFileSync(packPath, "utf-8");

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch {
    return null;
  }

  if (parsed === null || parsed === undefined) return null;
  if (!isPlainObject(parsed)) return null;

  return parsed;
}

// ---------------------------------------------------------------------------
// Variable resolution
// ---------------------------------------------------------------------------

/**
 * Replace `${key}` placeholders in all string values throughout an object.
 *
 * - `variables` is a flat key→value map (e.g. `{ "lang.test_command": "npm test" }`).
 * - Placeholders referencing missing keys resolve to empty string.
 * - Non-string values are left untouched.
 * - Works recursively through nested objects and arrays.
 */
export function resolveVariables(
  obj: unknown,
  variables: Record<string, string>,
): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
      return variables[key] ?? "";
    });
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => resolveVariables(item, variables));
  }

  if (isPlainObject(obj)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveVariables(value, variables);
    }
    return result;
  }

  return obj;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const CONFIG_DIR = ".rigor";
const CONFIG_FILE = "config.yaml";

/**
 * Load Rigor configuration from `<projectRoot>/.rigor/config.yaml`.
 *
 * Merge cascade: core DEFAULTS → domain pack defaults → user config.
 *
 * - If the file does not exist, returns {@link DEFAULTS}.
 * - If the file exists, deep-merges its values over DEFAULTS (arrays replace,
 *   objects merge, primitives override).
 * - If `domain` is set, loads the domain pack's `defaults.yaml` and inserts
 *   it between core defaults and user config in the merge cascade.
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

  // Build the merge cascade: DEFAULTS → domain pack → user config
  let base = structuredClone(DEFAULTS) as unknown as Record<string, unknown>;

  // If user config specifies a domain, load the domain pack defaults
  const domain = parsed["domain"];
  if (typeof domain === "string" && domain !== "") {
    const domainDefaults = loadDomainPackDefaults(domain, projectRoot);
    if (domainDefaults) {
      base = deepMerge(base, domainDefaults);
    }
  }

  // Merge user config on top (user always wins)
  const merged = deepMerge(base, parsed);
  const config = merged as unknown as RigorConfig;

  // Migrate legacy Gate 0 fields to checks[] for backward compat.
  migrateGate0Config(config);

  return config;
}
