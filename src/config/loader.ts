/**
 * Config loader — reads .rigor/config.yaml and deep-merges with DEFAULTS.
 *
 * Merge cascade: core DEFAULTS → domain pack defaults → global config → project config → env vars.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
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

  if (g0.design_command !== "") {
    checks.push({ name: "design-quality", command: g0.design_command });
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
// Global config path
// ---------------------------------------------------------------------------

const CONFIG_DIR = ".rigor";
const CONFIG_FILE = "config.yaml";

/**
 * Returns the platform-appropriate global config path.
 * - Windows: %APPDATA%/rigor/config.yaml
 * - Linux/macOS: ~/.config/rigor/config.yaml
 */
export function getGlobalConfigPath(): string {
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "rigor", CONFIG_FILE);
  }
  return join(homedir(), ".config", "rigor", CONFIG_FILE);
}

// ---------------------------------------------------------------------------
// YAML file reader
// ---------------------------------------------------------------------------

/**
 * Read and parse a YAML file. Returns null if file does not exist or is empty.
 * Throws on invalid YAML.
 */
function readYamlFile(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) {
    return null;
  }

  const raw = readFileSync(filePath, "utf-8");

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Failed to parse YAML config at ${filePath}: ${message}`);
  }

  if (parsed === null || parsed === undefined) {
    return null;
  }

  if (!isPlainObject(parsed)) {
    throw new Error(
      `Invalid config at ${filePath}: expected an object, got ${typeof parsed}`,
    );
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Env var overrides
// ---------------------------------------------------------------------------

/**
 * Apply env var overrides to config.
 * Currently supports:
 *   RIGOR_SYNC_ENABLED=true  -> config.sync.enabled = true
 */
function applyEnvOverrides(config: RigorConfig): void {
  const syncEnabled = process.env.RIGOR_SYNC_ENABLED;
  if (syncEnabled !== undefined) {
    config.sync.enabled = syncEnabled === "true" || syncEnabled === "1";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load Rigor configuration with full cascade:
 *   DEFAULTS → domain pack → global config → project config → env vars
 *
 * - Domain pack defaults are loaded if `domain` is set in project config.
 * - Global config is silently ignored if missing.
 * - Project config merges on top of global.
 * - Env vars override everything.
 * - Legacy Gate 0 fields are migrated to checks[] for backward compat.
 */
export function loadConfig(projectRoot: string): RigorConfig {
  let base = structuredClone(DEFAULTS) as unknown as Record<string, unknown>;

  // Layer 1: Global config
  const globalPath = getGlobalConfigPath();
  const globalConfig = readYamlFile(globalPath);
  if (globalConfig) {
    base = deepMerge(base, globalConfig);
  }

  // Layer 2: Project config
  const projectPath = join(projectRoot, CONFIG_DIR, CONFIG_FILE);
  const projectConfig = readYamlFile(projectPath);

  // If project config specifies a domain, load domain pack defaults
  // between core defaults and user config in the cascade.
  if (projectConfig) {
    const domain = projectConfig["domain"];
    if (typeof domain === "string" && domain !== "") {
      const domainDefaults = loadDomainPackDefaults(domain, projectRoot);
      if (domainDefaults) {
        base = deepMerge(base, domainDefaults);
      }
    }

    // Merge project config on top (user always wins over domain pack + global)
    base = deepMerge(base, projectConfig);
  }

  const config = base as unknown as RigorConfig;

  // Migrate legacy Gate 0 fields to checks[] for backward compat.
  migrateGate0Config(config);

  // Layer 3: Env var overrides
  applyEnvOverrides(config);

  return config;
}
