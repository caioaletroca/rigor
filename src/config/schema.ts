/**
 * RigorConfig type definitions and default values.
 *
 * Mirrors the YAML structure in .rigor/config.yaml.
 * See skills/config.example.yaml for the full annotated spec.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommitConfig {
  gpg_sign: boolean;
  trailers: Array<{ key: string; value: string }>;
  types: string[];
  require_scope: boolean;
}

export interface ShipConfig {
  branch_pattern: string;
  force_push: "never" | "ask" | "allow";
}

/** A metric parsed from command output and compared against a threshold. */
export interface Metric {
  /** Regex pattern with a capture group for the numeric value. */
  parse: string;
  /** Minimum value to pass. */
  threshold: number;
  /** Human-readable label (e.g. "coverage", "score"). */
  label: string;
}

/** A single check to run during Gate 0. */
export interface Check {
  /** Short name for the check (e.g. "tests", "lint", "typecheck"). */
  name: string;
  /** Shell command to execute. */
  command: string;
  /** Optional metric extraction from command output. */
  metric?: Metric;
}

export interface Gate0Config {
  /** @deprecated Use `checks` instead. Kept for backward compatibility. */
  coverage_threshold: number;
  /** @deprecated Use `checks` instead. Kept for backward compatibility. */
  lint_command: string;
  /** @deprecated Use `checks` instead. Kept for backward compatibility. */
  test_command: string;
  design_command: string;
  require_test_files: boolean;
  /** Generic checks array. When non-empty, replaces test_command/lint_command. */
  checks: Check[];
  /**
   * When no runnable check resolves (empty `checks`, or every command empty/
   * unresolved), Gate 0 FAILS by default rather than silently certifying an
   * unverified task. Set `true` to allow an empty gate to pass (e.g. docs-only
   * projects). Default: false.
   */
  allow_empty: boolean;
}

export interface Gate8Config {
  reviewers: string[];
  required_reviewers: string[];
  max_critical_findings: number;
  max_high_findings: number;
}

export interface Gate9Config {
  require_user_approval: boolean;
}

export interface Gate1Config {
  enabled: boolean;
  audit_command: string;
}

export type CustomGatePosition = "pre_task" | "post_task" | "pre_review" | "post_accept";

export interface CustomGateConfig {
  name: string;
  command: string;
  position: CustomGatePosition;
  timeout_ms?: number;
}

export interface GatesConfig {
  gate_0: Gate0Config;
  gate_1: Gate1Config;
  gate_8: Gate8Config;
  gate_9: Gate9Config;
  custom_gates: CustomGateConfig[];
}

/** Provider-specific config — discriminated by `type` field. */
export interface SyncProviderConfig {
  /** Provider type: "webhook", "jira", "github-projects", etc. */
  type: string;
  /** Optional allowlist of event types this provider handles. */
  events?: string[];
  /** All other fields are provider-specific (url, token, project_key, etc.). */
  [key: string]: unknown;
}

export interface SyncConfig {
  /** Enable/disable the sync layer. Default: false. */
  enabled: boolean;
  /** Name of the primary provider (for tooling queries). */
  primary?: string;
  /** Named map of provider configs. Keys are logical names. */
  providers: Record<string, SyncProviderConfig>;
}

export interface RigorConfig {
  /** Domain pack to load (e.g. "software"). Undefined means no domain pack. */
  domain?: string;
  commit: CommitConfig;
  ship: ShipConfig;
  gates: GatesConfig;
  sync: SyncConfig;
}

// ---------------------------------------------------------------------------
// Defaults (must match skills/config.example.yaml exactly)
// ---------------------------------------------------------------------------

export const DEFAULTS: RigorConfig = {
  commit: {
    gpg_sign: false,
    trailers: [],
    types: [
      "feat",
      "fix",
      "chore",
      "docs",
      "refactor",
      "test",
      "style",
      "perf",
      "ci",
      "build",
    ],
    require_scope: true,
  },
  ship: {
    branch_pattern: "<type>/<description>",
    force_push: "never",
  },
  gates: {
    gate_0: {
      coverage_threshold: 85,
      lint_command: "",
      test_command: "",
      design_command: "",
      require_test_files: true,
      checks: [],
      allow_empty: false,
    },
    gate_1: {
      enabled: true,
      audit_command: "",
    },
    gate_8: {
      reviewers: [
        "code-quality",
        "security",
        "logic",
        "test-quality",
        "nil-safety",
        "consequences",
        "dead-code",
        "performance",
        "requirements",
        "design-quality",
      ],
      required_reviewers: ["security", "logic"],
      max_critical_findings: 0,
      max_high_findings: 0,
    },
    gate_9: {
      require_user_approval: true,
    },
    custom_gates: [],
  },
  sync: {
    enabled: false,
    providers: {},
  },
};
