import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebhookProvider, resolveEnvVars } from "../providers/webhook.js";
import type { WebhookProviderConfig } from "../providers/webhook.js";
import type { SyncEvent, SyncEventType } from "../schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(type: SyncEventType = "task_started"): SyncEvent {
  return {
    type,
    entity_type: "task",
    entity_id: "1.1.1",
    cycle_id: "test-cycle",
    timestamp: "2026-07-17T12:00:00.000Z",
    previous_status: "pending",
    new_status: "doing",
  };
}

// ---------------------------------------------------------------------------
// resolveEnvVars
// ---------------------------------------------------------------------------

describe("resolveEnvVars", () => {
  afterEach(() => {
    delete process.env.TEST_TOKEN;
    delete process.env.TEST_USER;
  });

  it("replaces ${VAR} with env value", () => {
    process.env.TEST_TOKEN = "secret123";
    expect(resolveEnvVars("Bearer ${TEST_TOKEN}")).toBe("Bearer secret123");
  });

  it("replaces multiple variables", () => {
    process.env.TEST_TOKEN = "tok";
    process.env.TEST_USER = "usr";
    expect(resolveEnvVars("${TEST_USER}:${TEST_TOKEN}")).toBe("usr:tok");
  });

  it("throws when env var is missing", () => {
    expect(() => resolveEnvVars("${NONEXISTENT_VAR_12345}")).toThrow(
      'Environment variable "NONEXISTENT_VAR_12345" is not set',
    );
  });

  it("returns plain strings unchanged", () => {
    expect(resolveEnvVars("no vars here")).toBe("no vars here");
  });
});

// ---------------------------------------------------------------------------
// WebhookProvider
// ---------------------------------------------------------------------------

describe("WebhookProvider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchOk(status = 200): void {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status,
      statusText: "OK",
      text: async () => "ok",
    });
  }

  function mockFetchFail(status = 500, body = "Internal Server Error"): void {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status,
      statusText: "Internal Server Error",
      text: async () => body,
    });
  }

  // -----------------------------------------------------------------------
  // Successful POST
  // -----------------------------------------------------------------------

  it("sends a POST with correct URL, headers, and JSON body", async () => {
    mockFetchOk();
    const provider = new WebhookProvider({
      url: "https://hooks.example.com/webhook",
      headers: { "X-Custom": "value" },
    });

    const event = makeEvent();
    await provider.sync(event);

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toBe("https://hooks.example.com/webhook");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(opts.headers["X-Custom"]).toBe("value");

    const body = JSON.parse(opts.body as string) as SyncEvent;
    expect(body.type).toBe("task_started");
    expect(body.entity_id).toBe("1.1.1");
  });

  // -----------------------------------------------------------------------
  // Non-2xx response
  // -----------------------------------------------------------------------

  it("throws on non-2xx response with status info", async () => {
    mockFetchFail(403, "Forbidden");
    const provider = new WebhookProvider({
      url: "https://hooks.example.com/webhook",
    });

    await expect(provider.sync(makeEvent())).rejects.toThrow(
      /Webhook returned 403/,
    );
  });

  // -----------------------------------------------------------------------
  // PUT method
  // -----------------------------------------------------------------------

  it("uses PUT when configured", async () => {
    mockFetchOk();
    const provider = new WebhookProvider({
      url: "https://hooks.example.com/webhook",
      method: "PUT",
    });

    await provider.sync(makeEvent());

    const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.method).toBe("PUT");
  });

  // -----------------------------------------------------------------------
  // Name derivation
  // -----------------------------------------------------------------------

  it("derives name from URL hostname when not specified", () => {
    const provider = new WebhookProvider({
      url: "https://hooks.slack.com/services/xxx",
    });
    expect(provider.name).toBe("webhook:hooks.slack.com");
  });

  it("uses provided name over derived", () => {
    const provider = new WebhookProvider({
      name: "my-slack",
      url: "https://hooks.slack.com/services/xxx",
    });
    expect(provider.name).toBe("my-slack");
  });

  // -----------------------------------------------------------------------
  // Env var interpolation in headers
  // -----------------------------------------------------------------------

  it("resolves env vars in header values at construction", () => {
    process.env.TEST_TOKEN = "bearer-value";
    const provider = new WebhookProvider({
      url: "https://hooks.example.com/webhook",
      headers: { Authorization: "Bearer ${TEST_TOKEN}" },
    });

    // Verify the resolved value is stored (test via a sync call)
    mockFetchOk();
    provider.sync(makeEvent());

    const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.headers.Authorization).toBe("Bearer bearer-value");

    delete process.env.TEST_TOKEN;
  });

  // -----------------------------------------------------------------------
  // Missing env var at construction
  // -----------------------------------------------------------------------

  it("throws at construction when env var is missing", () => {
    expect(
      () =>
        new WebhookProvider({
          url: "https://hooks.example.com/webhook",
          headers: { Authorization: "Bearer ${MISSING_ENV_VAR_999}" },
        }),
    ).toThrow('Environment variable "MISSING_ENV_VAR_999" is not set');
  });

  // -----------------------------------------------------------------------
  // Event filtering
  // -----------------------------------------------------------------------

  it("passes events filter through to provider interface", () => {
    const provider = new WebhookProvider({
      url: "https://hooks.example.com/webhook",
      events: ["task_completed", "epic_completed"],
    });
    expect(provider.events).toEqual(["task_completed", "epic_completed"]);
  });

  // -----------------------------------------------------------------------
  // Timeout
  // -----------------------------------------------------------------------

  it("passes AbortSignal.timeout to fetch", async () => {
    mockFetchOk();
    const provider = new WebhookProvider({
      url: "https://hooks.example.com/webhook",
      timeout_ms: 5000,
    });

    await provider.sync(makeEvent());

    const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.signal).toBeDefined();
  });
});
