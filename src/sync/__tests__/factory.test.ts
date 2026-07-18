import { describe, it, expect, vi, afterEach } from "vitest";
import { createProviders } from "../factory.js";
import type { SyncConfig } from "../../config/schema.js";

describe("createProviders", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a WebhookProvider from webhook config", () => {
    const config: SyncConfig = {
      enabled: true,
      providers: {
        "my-hook": {
          type: "webhook",
          url: "https://hooks.example.com/test",
        },
      },
    };

    const providers = createProviders(config);
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe("my-hook");
  });

  it("creates multiple providers", () => {
    const config: SyncConfig = {
      enabled: true,
      providers: {
        "hook-a": {
          type: "webhook",
          url: "https://a.example.com/hook",
        },
        "hook-b": {
          type: "webhook",
          url: "https://b.example.com/hook",
          events: ["task_completed"],
        },
      },
    };

    const providers = createProviders(config);
    expect(providers).toHaveLength(2);
    expect(providers[0].name).toBe("hook-a");
    expect(providers[1].name).toBe("hook-b");
    expect(providers[1].events).toEqual(["task_completed"]);
  });

  it("skips unknown provider types with a warning", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const config: SyncConfig = {
      enabled: true,
      providers: {
        "my-unknown": {
          type: "unknown-platform",
        },
      },
    };

    const providers = createProviders(config);
    expect(providers).toHaveLength(0);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown provider type "unknown-platform"'),
    );
  });

  it("returns empty array for empty providers map", () => {
    const config: SyncConfig = {
      enabled: true,
      providers: {},
    };

    const providers = createProviders(config);
    expect(providers).toEqual([]);
  });
});
