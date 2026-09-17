import { describe, expect, it } from "vitest";
import { evaluateResolvedProjectReadiness } from "./project-readiness.js";
import { DEFAULTS } from "../config/index.js";

describe("project readiness service", () => {
  it("reports unresolved Gate 0 variables without running commands", () => {
    const readiness = evaluateResolvedProjectReadiness(
      {
        project_root: process.cwd(),
        source: "fallback",
        warning: "Using the server fallback root.",
      },
      {
        ...DEFAULTS,
        gates: {
          ...DEFAULTS.gates,
          gate_0: {
            ...DEFAULTS.gates.gate_0,
            checks: [{ name: "tests", command: "${lang.test_command}" }],
          },
        },
      },
    );

    expect(readiness.gate_0.ready).toBe(false);
    expect(readiness.gate_0.unresolved_variables).toEqual(["lang.test_command"]);
    expect(readiness.fallback_warning).toBe("Using the server fallback root.");
  });
});
