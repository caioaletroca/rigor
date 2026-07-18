import { describe, it, expect, vi, afterEach } from "vitest";
import { BaseProvider, resolveEnvVar } from "../providers/base.js";
import type { BaseProviderConfig } from "../providers/base.js";
import type { SyncEvent } from "../schema.js";

// ---------------------------------------------------------------------------
// Concrete test implementation
// ---------------------------------------------------------------------------

class TestProvider extends BaseProvider {
  public handleEventFn: (event: SyncEvent) => Promise<void>;

  constructor(
    config: BaseProviderConfig,
    handleFn?: (event: SyncEvent) => Promise<void>,
  ) {
    super(config);
    this.handleEventFn = handleFn ?? (async () => {});
  }

  protected async handleEvent(event: SyncEvent): Promise<void> {
    return this.handleEventFn(event);
  }
}

function makeEvent(): SyncEvent {
  return {
    type: "task_started",
    entity_type: "task",
    entity_id: "1.1.1",
    cycle_id: "test-cycle",
    timestamp: new Date().toISOString(),
    previous_status: "pending",
    new_status: "doing",
  };
}

// ---------------------------------------------------------------------------
// resolveEnvVar
// ---------------------------------------------------------------------------

describe("resolveEnvVar", () => {
  afterEach(() => {
    delete process.env.TEST_BASE_VAR;
  });

  it("resolves env vars", () => {
    process.env.TEST_BASE_VAR = "resolved";
    expect(resolveEnvVar("prefix-${TEST_BASE_VAR}-suffix")).toBe(
      "prefix-resolved-suffix",
    );
  });

  it("throws on missing env var", () => {
    expect(() => resolveEnvVar("${MISSING_BASE_VAR_999}")).toThrow(
      'Environment variable "MISSING_BASE_VAR_999" is not set',
    );
  });
});

// ---------------------------------------------------------------------------
// BaseProvider
// ---------------------------------------------------------------------------

describe("BaseProvider", () => {
  it("delegates to handleEvent on sync()", async () => {
    const handleFn = vi.fn(async () => {});
    const provider = new TestProvider({ name: "test" }, handleFn);

    const event = makeEvent();
    await provider.sync(event);

    expect(handleFn).toHaveBeenCalledWith(event);
  });

  it("retries on transient errors", async () => {
    let attempts = 0;
    const provider = new TestProvider(
      { name: "retry-test", max_retries: 2, retry_delay_ms: 10 },
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("Webhook returned 500 Internal Server Error");
        }
      },
    );

    await provider.sync(makeEvent());
    expect(attempts).toBe(3); // 1 initial + 2 retries
  });

  it("does not retry non-transient errors", async () => {
    let attempts = 0;
    const provider = new TestProvider(
      { name: "no-retry", max_retries: 2, retry_delay_ms: 10 },
      async () => {
        attempts++;
        throw new Error("Authentication failed: 401");
      },
    );

    await expect(provider.sync(makeEvent())).rejects.toThrow(
      "Authentication failed: 401",
    );
    expect(attempts).toBe(1); // no retry
  });

  it("retries on network errors", async () => {
    let attempts = 0;
    const provider = new TestProvider(
      { name: "network-retry", max_retries: 1, retry_delay_ms: 10 },
      async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("fetch failed: ECONNREFUSED");
        }
      },
    );

    await provider.sync(makeEvent());
    expect(attempts).toBe(2);
  });

  it("retries on 429 rate limit", async () => {
    let attempts = 0;
    const provider = new TestProvider(
      { name: "rate-limit", max_retries: 1, retry_delay_ms: 10 },
      async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("Webhook returned 429 Too Many Requests");
        }
      },
    );

    await provider.sync(makeEvent());
    expect(attempts).toBe(2);
  });

  it("gives up after max retries", async () => {
    const provider = new TestProvider(
      { name: "give-up", max_retries: 1, retry_delay_ms: 10 },
      async () => {
        throw new Error("Webhook returned 503 Service Unavailable");
      },
    );

    await expect(provider.sync(makeEvent())).rejects.toThrow(
      "503 Service Unavailable",
    );
  });

  // -----------------------------------------------------------------------
  // Status and entity mapping
  // -----------------------------------------------------------------------

  it("maps status using default status map", () => {
    const provider = new TestProvider({ name: "map-test" });
    // Access protected method via any
    expect((provider as any).mapStatus("doing")).toBe("In Progress");
    expect((provider as any).mapStatus("done")).toBe("Done");
    expect((provider as any).mapStatus("failed")).toBe("Blocked");
    expect((provider as any).mapStatus("pending")).toBe("To Do");
  });

  it("maps status using custom status map", () => {
    const provider = new TestProvider({
      name: "custom-map",
      status_map: { doing: "Working", done: "Finished" },
    });
    expect((provider as any).mapStatus("doing")).toBe("Working");
    expect((provider as any).mapStatus("done")).toBe("Finished");
    // Unmapped status falls through
    expect((provider as any).mapStatus("pending")).toBe("pending");
  });

  it("maps entity types using default entity map", () => {
    const provider = new TestProvider({ name: "entity-map" });
    expect((provider as any).mapEntityType("cycle")).toBe("epic");
    expect((provider as any).mapEntityType("epic")).toBe("story");
    expect((provider as any).mapEntityType("task")).toBe("subtask");
  });

  it("maps entity types using custom entity map", () => {
    const provider = new TestProvider({
      name: "custom-entity",
      entity_map: { task: "issue", epic: "feature" },
    });
    expect((provider as any).mapEntityType("task")).toBe("issue");
    expect((provider as any).mapEntityType("epic")).toBe("feature");
  });

  // -----------------------------------------------------------------------
  // Name and events passthrough
  // -----------------------------------------------------------------------

  it("passes name and events from config", () => {
    const provider = new TestProvider({
      name: "my-provider",
      events: ["task_completed", "epic_completed"],
    });
    expect(provider.name).toBe("my-provider");
    expect(provider.events).toEqual(["task_completed", "epic_completed"]);
  });

  // -----------------------------------------------------------------------
  // Zero retries
  // -----------------------------------------------------------------------

  it("works with max_retries=0 (no retries)", async () => {
    let attempts = 0;
    const provider = new TestProvider(
      { name: "no-retries", max_retries: 0, retry_delay_ms: 10 },
      async () => {
        attempts++;
        throw new Error("Webhook returned 500");
      },
    );

    await expect(provider.sync(makeEvent())).rejects.toThrow("500");
    expect(attempts).toBe(1);
  });
});
