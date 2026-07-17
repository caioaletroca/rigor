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

export interface Gate0Config {
  coverage_threshold: number;
  lint_command: string;
  test_command: string;
  require_test_files: boolean;
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

export interface GatesConfig {
  gate_0: Gate0Config;
  gate_8: Gate8Config;
  gate_9: Gate9Config;
}

export interface RigorConfig {
  commit: CommitConfig;
  ship: ShipConfig;
  gates: GatesConfig;
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
      require_test_files: true,
    },
    gate_8: {
      reviewers: ["code-quality", "security", "logic", "test-quality"],
      required_reviewers: ["security", "logic"],
      max_critical_findings: 0,
      max_high_findings: 0,
    },
    gate_9: {
      require_user_approval: true,
    },
  },
};
