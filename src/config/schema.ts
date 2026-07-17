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

export interface Gate1Config {
  enabled: boolean;
  audit_command: string;
}

export interface Gate2Config {
  enabled: boolean;
  required: boolean;
  a11y_command: string;
  max_violations: number;
}

export interface Gate3Config {
  enabled: boolean;
  required: boolean;
  visual_test_command: string;
}

export interface Gate4Config {
  enabled: boolean;
  required: boolean;
  e2e_command: string;
}

export interface Gate5Config {
  enabled: boolean;
  required: boolean;
  perf_command: string;
  min_score: number;
  budget_file: string;
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
  gate_2: Gate2Config;
  gate_3: Gate3Config;
  gate_4: Gate4Config;
  gate_5: Gate5Config;
  gate_8: Gate8Config;
  gate_9: Gate9Config;
  custom_gates: CustomGateConfig[];
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
    gate_1: {
      enabled: true,
      audit_command: "",
    },
    gate_2: {
      enabled: true,
      required: false,
      a11y_command: "npx axe-core-cli",
      max_violations: 0,
    },
    gate_3: {
      enabled: true,
      required: false,
      visual_test_command: "npx vitest run --project visual",
    },
    gate_4: {
      enabled: true,
      required: false,
      e2e_command: "npx playwright test",
    },
    gate_5: {
      enabled: true,
      required: false,
      perf_command: "npx lighthouse-ci",
      min_score: 90,
      budget_file: "",
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
};
