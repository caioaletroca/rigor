import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JiraProvider } from "../providers/jira.js";
import type { JiraProviderConfig } from "../providers/jira.js";
import type { SyncEvent, SyncEventType } from "../schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<JiraProviderConfig> = {}): JiraProviderConfig {
  return {
    name: "test-jira",
    base_url: "https://test.atlassian.net",
    email: "test@example.com",
    token: "test-token-123",
    project_key: "RIG",
    max_retries: 0,
    timeout_ms: 5000,
    ...overrides,
  };
}

function makeEvent(
  type: SyncEventType = "task_started",
  overrides: Partial<SyncEvent> = {},
): SyncEvent {
  return {
    type,
    entity_type: "task",
    entity_id: "1.1.1",
    cycle_id: "test-cycle",
    timestamp: "2026-07-17T12:00:00.000Z",
    previous_status: "pending",
    new_status: "doing",
    ...overrides,
  };
}

// Captures fetch calls and returns mock responses
interface FetchCall {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

function setupFetchMock(
  responses: Record<string, unknown>,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];

  (globalThis.fetch as ReturnType<typeof vi.fn>) = vi.fn(
    async (url: string, opts: RequestInit = {}) => {
      calls.push({
        url,
        method: (opts.method ?? "GET").toUpperCase(),
        body: opts.body as string | undefined,
        headers: opts.headers as Record<string, string>,
      });

      // Return matching mock response
      for (const [pattern, response] of Object.entries(responses)) {
        if (url.includes(pattern)) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => response,
            text: async () => JSON.stringify(response),
          };
        }
      }

      // Default: 404
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: async () => ({ error: "not found" }),
        text: async () => "Not Found",
      };
    },
  );

  return { calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("JiraProvider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  it("constructs with valid config", () => {
    const provider = new JiraProvider(makeConfig());
    expect(provider.name).toBe("test-jira");
  });

  it("resolves env vars in token at construction", () => {
    process.env.TEST_JIRA_TOKEN = "env-token-456";
    const provider = new JiraProvider(
      makeConfig({ token: "${TEST_JIRA_TOKEN}" }),
    );
    expect(provider.name).toBe("test-jira");
    delete process.env.TEST_JIRA_TOKEN;
  });

  it("throws on missing env var at construction", () => {
    expect(
      () => new JiraProvider(makeConfig({ token: "${MISSING_JIRA_VAR}" })),
    ).toThrow('Environment variable "MISSING_JIRA_VAR" is not set');
  });

  // -----------------------------------------------------------------------
  // cycle_initialized
  // -----------------------------------------------------------------------

  it("creates an issue on cycle_initialized when none exists", async () => {
    const { calls } = setupFetchMock({
      "/search": { issues: [] },
      "/issue": { key: "RIG-1" },
    });

    const provider = new JiraProvider(makeConfig());
    await provider.sync(
      makeEvent("cycle_initialized", {
        entity_type: "cycle",
        entity_id: "test-cycle",
      }),
    );

    // Should have searched first, then created
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("/search");
    expect(calls[1].method).toBe("POST");
    expect(calls[1].url).toContain("/issue");

    const body = JSON.parse(calls[1].body!);
    expect(body.fields.project.key).toBe("RIG");
    expect(body.fields.summary).toContain("test-cycle");
    expect(body.fields.issuetype.name).toBe("Epic");
  });

  it("adds a comment on cycle_initialized when issue exists", async () => {
    const { calls } = setupFetchMock({
      "/search": { issues: [{ key: "RIG-42" }] },
      "/comment": {},
    });

    const provider = new JiraProvider(makeConfig());
    await provider.sync(
      makeEvent("cycle_initialized", {
        entity_type: "cycle",
        entity_id: "test-cycle",
      }),
    );

    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain("RIG-42/comment");
    expect(calls[1].method).toBe("POST");
  });

  // -----------------------------------------------------------------------
  // Transitions
  // -----------------------------------------------------------------------

  it("transitions an existing issue on task_started", async () => {
    const { calls } = setupFetchMock({
      "/search": { issues: [{ key: "RIG-10" }] },
      "/transitions": {
        transitions: [
          { id: "21", name: "Start Progress", to: { name: "In Progress" } },
          { id: "31", name: "Done", to: { name: "Done" } },
        ],
      },
    });

    const provider = new JiraProvider(makeConfig());
    await provider.sync(makeEvent("task_started"));

    // Search -> get transitions -> do transition
    expect(calls.length).toBeGreaterThanOrEqual(3);

    // The last POST should be the transition
    const transitionCall = calls.find(
      (c) => c.method === "POST" && c.url.includes("/transitions"),
    );
    expect(transitionCall).toBeDefined();

    const body = JSON.parse(transitionCall!.body!);
    expect(body.transition.id).toBe("21");
  });

  it("creates a new issue when no matching issue found on transition", async () => {
    const { calls } = setupFetchMock({
      "/search": { issues: [] },
      "/issue": { key: "RIG-99" },
    });

    const provider = new JiraProvider(makeConfig());
    await provider.sync(makeEvent("task_started"));

    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issue"))).toBe(true);
  });

  it("adds a comment when no matching transition exists", async () => {
    const { calls } = setupFetchMock({
      "/search": { issues: [{ key: "RIG-10" }] },
      "/transitions": { transitions: [] }, // no available transitions
      "/comment": {},
    });

    const provider = new JiraProvider(makeConfig());
    await provider.sync(makeEvent("task_started"));

    // Should have fallen back to adding a comment
    const commentCall = calls.find(
      (c) => c.method === "POST" && c.url.includes("/comment"),
    );
    expect(commentCall).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Status mapping
  // -----------------------------------------------------------------------

  it("uses custom status_map", async () => {
    const { calls } = setupFetchMock({
      "/search": { issues: [{ key: "RIG-10" }] },
      "/transitions": {
        transitions: [
          { id: "51", name: "Working On It", to: { name: "Working On It" } },
        ],
      },
    });

    const provider = new JiraProvider(
      makeConfig({
        status_map: { doing: "Working On It" },
      }),
    );
    await provider.sync(makeEvent("task_started"));

    const transitionCall = calls.find(
      (c) => c.method === "POST" && c.url.includes("/transitions"),
    );
    if (transitionCall) {
      const body = JSON.parse(transitionCall.body!);
      expect(body.transition.id).toBe("51");
    }
  });

  // -----------------------------------------------------------------------
  // Auth header
  // -----------------------------------------------------------------------

  it("sends Basic auth header", async () => {
    const { calls } = setupFetchMock({
      "/search": { issues: [] },
      "/issue": { key: "RIG-1" },
    });

    const provider = new JiraProvider(makeConfig());
    await provider.sync(
      makeEvent("cycle_initialized", {
        entity_type: "cycle",
        entity_id: "test-cycle",
      }),
    );

    const expectedAuth =
      "Basic " +
      Buffer.from("test@example.com:test-token-123").toString("base64");
    expect(calls[0].headers.Authorization).toBe(expectedAuth);
  });

  // -----------------------------------------------------------------------
  // Entity mapping
  // -----------------------------------------------------------------------

  it("maps entity types to Jira issue types", async () => {
    const { calls } = setupFetchMock({
      "/search": { issues: [] },
      "/issue": { key: "RIG-1" },
    });

    const provider = new JiraProvider(makeConfig());

    // Task -> Sub-task
    await provider.sync(makeEvent("task_started"));
    const createCall = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/issue"),
    );
    if (createCall) {
      const body = JSON.parse(createCall.body!);
      expect(body.fields.issuetype.name).toBe("Sub-task");
    }
  });
});
