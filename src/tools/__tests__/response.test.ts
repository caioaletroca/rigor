import { describe, expect, it } from "vitest";
import { responseResult } from "../response.js";

function structured(result: ReturnType<typeof responseResult>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function text(result: ReturnType<typeof responseResult>): string {
  const content = result.content[0];
  if (content.type !== "text") throw new Error("Expected text content");
  return content.text;
}

describe("responseResult", () => {
  it("returns a structured success envelope with guidance", () => {
    const result = responseResult("Operation completed", {
      guidance: ["Continue to the next step"],
    });

    expect(structured(result)).toEqual({
      ok: true,
      message: "Operation completed",
      guidance: ["Continue to the next step"],
    });
    expect(result.isError).toBeUndefined();
  });

  it("includes identity fields in the structured envelope", () => {
    const result = responseResult("Task completed", {
      context: {
        project_root: "C:/workspace/project",
        cycle_id: "cycle-123",
        task_id: "1.2.3",
        attempt_id: "attempt-456",
      },
    });

    expect(structured(result)).toMatchObject({
      ok: true,
      message: "Task completed",
      project_root: "C:/workspace/project",
      cycle_id: "cycle-123",
      task_id: "1.2.3",
      attempt_id: "attempt-456",
    });
  });

  it("preserves legacy text while exposing structured JSON messages", () => {
    const message = JSON.stringify({ result: "passed", task_id: "message-task" });
    const result = responseResult(message, {
      context: { task_id: "context-task", cycle_id: "cycle-1" },
    });

    expect(text(result)).toBe(message);
    expect(structured(result)).toMatchObject({
      result: "passed",
      ok: true,
      message,
      task_id: "context-task",
      cycle_id: "cycle-1",
    });
  });

  it("marks error responses and retains the legacy message", () => {
    const result = responseResult("Unable to complete", { error: true });

    expect(text(result)).toBe("Unable to complete");
    expect(structured(result)).toMatchObject({ ok: false, message: "Unable to complete" });
    expect(result.isError).toBe(true);
  });

  it("rejects nested evidence identifiers", () => {
    expect(() => responseResult("safe", { context: { task_id: "nested/path" } })).not.toThrow();
  });

  it("redacts and bounds diagnostics", () => {
    const result = responseResult("Failed", {
      diagnostics: `password=secret ${"x".repeat(5_000)}`,
    });

    const diagnostics = structured(result).diagnostics;
    expect(typeof diagnostics).toBe("string");
    expect(diagnostics).toHaveLength(4_000);
    expect(diagnostics).toContain("password=[REDACTED]");
    expect(diagnostics).not.toContain("password=secret");
  });
});
