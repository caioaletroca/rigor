/**
 * Pack discovery and validation.
 *
 * Auto-discovers custom lang packs and domain packs by scanning the
 * `skills/lang/` and `skills/domain/` directories. Also validates that
 * a lang pack's variables cover what a domain pack's defaults.yaml references.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveredPack {
  name: string;
  path: string;
  source: "builtin" | "custom";
}

export interface VariableValidation {
  valid: boolean;
  missing: string[];
  provided: string[];
  referenced: string[];
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Resolve the Rigor package root directory.
 */
function getPackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Scan a directory for subdirectories that contain a `defaults.yaml` or
 * `SKILL.md` / `DOMAIN.md` file (i.e., are valid packs).
 */
function scanPackDir(baseDir: string): string[] {
  if (!existsSync(baseDir)) return [];

  try {
    const entries = readdirSync(baseDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => {
        const dir = join(baseDir, name);
        return (
          existsSync(join(dir, "defaults.yaml")) ||
          existsSync(join(dir, "SKILL.md")) ||
          existsSync(join(dir, "DOMAIN.md"))
        );
      });
  } catch {
    return [];
  }
}

/**
 * Discover all available lang packs from both built-in and project-local
 * `skills/lang/` directories.
 */
export function discoverLangPacks(projectRoot: string): DiscoveredPack[] {
  const packageRoot = getPackageRoot();
  const packs: Map<string, DiscoveredPack> = new Map();

  // 1. Built-in packs
  const builtinDir = join(packageRoot, "skills", "lang");
  for (const name of scanPackDir(builtinDir)) {
    packs.set(name, {
      name,
      path: join(builtinDir, name),
      source: "builtin",
    });
  }

  // 2. Project-local packs (override built-in if same name)
  const projectDir = join(projectRoot, "skills", "lang");
  for (const name of scanPackDir(projectDir)) {
    packs.set(name, {
      name,
      path: join(projectDir, name),
      source: packs.has(name) ? "builtin" : "custom",
    });
  }

  return Array.from(packs.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/**
 * Discover all available domain packs from both built-in and project-local
 * `skills/domain/` directories.
 */
export function discoverDomainPacks(projectRoot: string): DiscoveredPack[] {
  const packageRoot = getPackageRoot();
  const packs: Map<string, DiscoveredPack> = new Map();

  // 1. Built-in packs
  const builtinDir = join(packageRoot, "skills", "domain");
  for (const name of scanPackDir(builtinDir)) {
    packs.set(name, {
      name,
      path: join(builtinDir, name),
      source: "builtin",
    });
  }

  // 2. Project-local packs
  const projectDir = join(projectRoot, "skills", "domain");
  for (const name of scanPackDir(projectDir)) {
    packs.set(name, {
      name,
      path: join(projectDir, name),
      source: packs.has(name) ? "builtin" : "custom",
    });
  }

  return Array.from(packs.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

// ---------------------------------------------------------------------------
// Variable validation
// ---------------------------------------------------------------------------

/**
 * Extract `${var.name}` placeholder references from a YAML string.
 */
function extractPlaceholders(yamlContent: string): string[] {
  const matches = yamlContent.matchAll(/\$\{([^}]+)\}/g);
  const vars = new Set<string>();
  for (const match of matches) {
    vars.add(match[1]);
  }
  return Array.from(vars);
}

/**
 * Extract variable keys from a lang pack's defaults.yaml `variables:` section.
 */
function extractProvidedVariables(defaultsPath: string): string[] {
  if (!existsSync(defaultsPath)) return [];

  const raw = readFileSync(defaultsPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch {
    return [];
  }

  if (
    parsed === null ||
    parsed === undefined ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return [];
  }

  const obj = parsed as Record<string, unknown>;
  const variables = obj.variables;
  if (
    variables === null ||
    variables === undefined ||
    typeof variables !== "object" ||
    Array.isArray(variables)
  ) {
    return [];
  }

  return Object.keys(variables as Record<string, unknown>);
}

/**
 * Validate that a lang pack provides all variables referenced by a domain
 * pack's defaults.yaml.
 *
 * @param langPackDir - Path to the lang pack directory (must contain defaults.yaml)
 * @param domainPackDir - Path to the domain pack directory (must contain defaults.yaml)
 * @returns Validation result with lists of provided, referenced, and missing variables
 */
export function validateLangPackVariables(
  langPackDir: string,
  domainPackDir: string,
): VariableValidation {
  const provided = extractProvidedVariables(join(langPackDir, "defaults.yaml"));

  const domainDefaultsPath = join(domainPackDir, "defaults.yaml");
  if (!existsSync(domainDefaultsPath)) {
    return { valid: true, missing: [], provided, referenced: [] };
  }

  const domainContent = readFileSync(domainDefaultsPath, "utf-8");
  const referenced = extractPlaceholders(domainContent);

  const missing = referenced.filter((v) => !provided.includes(v));

  return {
    valid: missing.length === 0,
    missing,
    provided,
    referenced,
  };
}
