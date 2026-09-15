import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "../state/index.js";
import { handleAcceptStart, handleReviewStart } from "./review-lifecycle.js";
import { DEFAULTS } from "../config/index.js";

describe("review lifecycle service", () => {
  it("rejects acceptance before Gate 8 passes", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "rigor-review-service-"));
    try {
      const stateManager = new StateManager(projectRoot);
      const result = handleAcceptStart({ epic_id: "1.1" }, stateManager);

      expect(result.isError).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects review when no cycle exists", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "rigor-review-service-"));
    try {
      const stateManager = new StateManager(projectRoot);
      const result = await handleReviewStart(
        { epic_id: "1.1" },
        stateManager,
        DEFAULTS,
        projectRoot,
      );

      expect(result.isError).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
