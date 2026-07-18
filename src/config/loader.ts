/**
 * Config loader — reads .rigor/config.yaml and deep-merges with DEFAULTS.
 *
 * Merge cascade: core DEFAULTS < global config < project config < env vars.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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
 *   DEFAULTS < global (~/.config/rigor/config.yaml) < project (.rigor/config.yaml) < env vars
 *
 * - Global config is silently ignored if missing.
 * - Project config merges on top of global.
 * - Env vars override both.
 * - Provider maps merge by key across global and project.
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
  if (projectConfig) {
    base = deepMerge(base, projectConfig);
  }

  const config = base as unknown as RigorConfig;

  // Layer 3: Env var overrides
  applyEnvOverrides(config);

  return config;
}
