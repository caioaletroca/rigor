import { describe, it, expect } from "vitest";
import { redact, redactEnv } from "../redact.js";

describe("redact", () => {
  it("replaces secret values from matching environment keys", () => {
    expect(redact("token=abc password=xyz ordinary=keep", {
      API_TOKEN: "abc",
      PASSWORD: "xyz",
      ORDINARY: "keep",
    })).toBe("token=[REDACTED] password=[REDACTED] ordinary=keep");
  });

  it("redacts inline credential assignments", () => {
    expect(redact("api_key: key-value authorization = bearer-token secret=quoted"))
      .toBe("api_key: [REDACTED] authorization = [REDACTED] secret=[REDACTED]");
  });

  it("redacts repeated occurrences and leaves unrelated values unchanged", () => {
    expect(redact("abc abc", { PRIVATE_KEY: "abc" })).toBe("[REDACTED] [REDACTED]");
    expect(redact("nothing sensitive here", { VALUE: "nothing" })).toBe("nothing sensitive here");
  });

  it("handles missing and empty environment values", () => {
    expect(redact("token=visible")).toBe("token=[REDACTED]");
    expect(redact("value", { TOKEN: "" })).toBe("value");
  });
});

describe("redactEnv", () => {
  it("replaces values for secret-looking keys", () => {
    expect(redactEnv({ API_TOKEN: "abc", PASSWORD: "xyz", HOST: "example" }))
      .toEqual({ API_TOKEN: "[REDACTED]", PASSWORD: "[REDACTED]", HOST: "example" });
  });

  it("preserves all input keys and non-secret values", () => {
    const env = { AUTH_MODE: "basic", PORT: "3000", EMPTY: "" };
    expect(redactEnv(env)).toEqual({ AUTH_MODE: "[REDACTED]", PORT: "3000", EMPTY: "" });
    expect(env).toEqual({ AUTH_MODE: "basic", PORT: "3000", EMPTY: "" });
  });
});
