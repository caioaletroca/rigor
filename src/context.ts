import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve, join } from "node:path";
import { realpathSync } from "node:fs";
import { StateManager } from "./state/index.js";
import { EvidenceManager } from "./evidence/index.js";
import { loadConfig } from "./config/index.js";
import type { RigorConfig } from "./config/index.js";
import { SyncManager } from "./sync/index.js";
import { createProviders } from "./sync/factory.js";

export interface ProjectRootResolution {
  project_root: string;
  source: "explicit" | "plan" | "fallback";
  warning?: string;
}

function canonicalize(path: string): string {
  const absolute = normalize(resolve(path));
  try {
    return normalize(realpathSync(absolute));
  } catch {
    return absolute;
  }
}

function findGitRoot(start: string): string | null {
  let current = canonicalize(start);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveProjectRoot(options: {
  project_root?: string;
  plan_path?: string;
  fallback_root: string;
}): ProjectRootResolution {
  const fallback = canonicalize(options.fallback_root);
  if (options.project_root) {
    const explicit = canonicalize(options.project_root);
    if (!existsSync(explicit) || !statSync(explicit).isDirectory()) {
      throw new Error("Invalid project_root: expected an existing directory.");
    }
    if (!existsSync(join(explicit, ".git"))) {
      throw new Error("Invalid project_root: expected a Git repository root.");
    }
    return { project_root: explicit, source: "explicit" };
  }
  if (options.plan_path && isAbsolute(options.plan_path)) {
    const planRoot = findGitRoot(dirname(normalize(options.plan_path)));
    if (planRoot) return { project_root: planRoot, source: "plan" };
  }
  return {
    project_root: fallback,
    source: "fallback",
    warning: "No Git repository root was found; using the server fallback root.",
  };
}

export interface RequestContext {
  project_root: string;
  readonly stateManager: StateManager;
  readonly evidenceManager: EvidenceManager;
  config: RigorConfig;
  readonly syncManager?: SyncManager;
}

export class ProjectContextRegistry {
  private readonly contexts = new Map<string, RequestContext>();

  constructor(
    private readonly defaultRoot?: string,
    private readonly syncManager?: SyncManager,
  ) {}

  get(options: Parameters<typeof resolveProjectRoot>[0]): RequestContext {
    const resolution = resolveProjectRoot({
      ...options,
      fallback_root: options.fallback_root ?? this.defaultRoot ?? process.cwd(),
    });
    const config = loadConfig(resolution.project_root);
    const existing = this.contexts.get(resolution.project_root);
    if (existing) {
      existing.config = config;
      return existing;
    }
    const localSyncManager = config.sync?.enabled
      ? new SyncManager(resolution.project_root, createProviders(config.sync), config.sync.primary)
      : undefined;
    const context: RequestContext = {
      project_root: resolution.project_root,
      stateManager: new StateManager(resolution.project_root, localSyncManager),
      evidenceManager: new EvidenceManager(resolution.project_root),
      config,
      syncManager: localSyncManager,
    };
    this.contexts.set(resolution.project_root, context);
    return context;
  }

  getByRoot(projectRoot: string): RequestContext {
    return this.get({ project_root: projectRoot, fallback_root: this.defaultRoot ?? process.cwd() });
  }
}
