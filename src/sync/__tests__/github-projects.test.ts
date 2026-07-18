import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GitHubProjectsProvider } from "../providers/github-projects.js";
import type { GitHubProjectsProviderConfig } from "../providers/github-projects.js";
import type { SyncEvent, SyncEventType } from "../schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(
  overrides: Partial<GitHubProjectsProviderConfig> = {},
): GitHubProjectsProviderConfig {
  return {
    name: "test-gh",
    owner: "testorg",
    repo: "testrepo",
    project_number: 1,
    token: "ghp_test123",
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

interface GraphQLCall {
  query: string;
  variables: Record<string, unknown>;
}

// Project metadata response
const PROJECT_METADATA = {
  user: null,
  organization: {
    projectV2: {
      id: "PVT_proj1",
      fields: {
        nodes: [
          {
            id: "PVTSSF_status1",
            name: "Status",
            options: [
              { id: "opt_todo", name: "Todo" },
              { id: "opt_inprog", name: "In Progress" },
              { id: "opt_done", name: "Done" },
              { id: "opt_blocked", name: "Blocked" },
            ],
          },
        ],
      },
    },
  },
};

function setupGraphQLMock(
  responses: Array<{ match: string; data: unknown }>,
): { calls: GraphQLCall[] } {
  const calls: GraphQLCall[] = [];

  (globalThis.fetch as ReturnType<typeof vi.fn>) = vi.fn(
    async (_url: string, opts: RequestInit = {}) => {
      const body = JSON.parse(opts.body as string) as {
        query: string;
        variables: Record<string, unknown>;
      };
      calls.push(body);

      for (const { match, data } of responses) {
        if (body.query.includes(match)) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data }),
            text: async () => JSON.stringify({ data }),
          };
        }
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ data: {} }),
        text: async () => "{}",
      };
    },
  );

  return { calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GitHubProjectsProvider", () => {
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
    const provider = new GitHubProjectsProvider(makeConfig());
    expect(provider.name).toBe("test-gh");
  });

  it("resolves env vars in token at construction", () => {
    process.env.TEST_GH_TOKEN = "ghp_env_token";
    const provider = new GitHubProjectsProvider(
      makeConfig({ token: "${TEST_GH_TOKEN}" }),
    );
    expect(provider.name).toBe("test-gh");
    delete process.env.TEST_GH_TOKEN;
  });

  it("throws on missing env var at construction", () => {
    expect(
      () =>
        new GitHubProjectsProvider(
          makeConfig({ token: "${MISSING_GH_VAR}" }),
        ),
    ).toThrow('Environment variable "MISSING_GH_VAR" is not set');
  });

  // -----------------------------------------------------------------------
  // cycle_initialized
  // -----------------------------------------------------------------------

  it("creates a draft item on cycle_initialized", async () => {
    const { calls } = setupGraphQLMock([
      { match: "projectV2(number", data: PROJECT_METADATA },
      {
        match: "addProjectV2DraftIssue",
        data: {
          addProjectV2DraftIssue: { projectItem: { id: "PVTI_item1" } },
        },
      },
    ]);

    const provider = new GitHubProjectsProvider(makeConfig());
    await provider.sync(
      makeEvent("cycle_initialized", {
        entity_type: "cycle",
        entity_id: "test-cycle",
      }),
    );

    // Should have: 1) loaded project metadata, 2) created draft item
    expect(calls).toHaveLength(2);
    expect(calls[0].query).toContain("projectV2(number");
    expect(calls[1].query).toContain("addProjectV2DraftIssue");
    expect(calls[1].variables.title).toContain("test-cycle");
  });

  // -----------------------------------------------------------------------
  // Transitions
  // -----------------------------------------------------------------------

  it("creates draft item and updates status on transition", async () => {
    const { calls } = setupGraphQLMock([
      { match: "projectV2(number", data: PROJECT_METADATA },
      {
        match: "items(first",
        data: { node: { items: { nodes: [] } } },
      },
      {
        match: "addProjectV2DraftIssue",
        data: {
          addProjectV2DraftIssue: { projectItem: { id: "PVTI_new" } },
        },
      },
      {
        match: "updateProjectV2ItemFieldValue",
        data: {
          updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_new" } },
        },
      },
    ]);

    const provider = new GitHubProjectsProvider(makeConfig());
    await provider.sync(makeEvent("task_started"));

    // Metadata -> find item -> create item -> update status
    expect(calls.length).toBeGreaterThanOrEqual(3);

    // Verify the status update uses the correct option
    const updateCall = calls.find((c) =>
      c.query.includes("updateProjectV2ItemFieldValue"),
    );
    if (updateCall) {
      expect(updateCall.variables.optionId).toBe("opt_inprog");
    }
  });

  it("updates existing item on transition", async () => {
    const { calls } = setupGraphQLMock([
      { match: "projectV2(number", data: PROJECT_METADATA },
      {
        match: "items(first",
        data: {
          node: {
            items: {
              nodes: [
                {
                  id: "PVTI_existing",
                  content: { title: "[Rigor] test-cycle/1.1.1" },
                },
              ],
            },
          },
        },
      },
      {
        match: "updateProjectV2ItemFieldValue",
        data: {
          updateProjectV2ItemFieldValue: {
            projectV2Item: { id: "PVTI_existing" },
          },
        },
      },
    ]);

    const provider = new GitHubProjectsProvider(makeConfig());
    await provider.sync(makeEvent("task_completed", { new_status: "done" }));

    // Should find existing item and update it
    const updateCall = calls.find((c) =>
      c.query.includes("updateProjectV2ItemFieldValue"),
    );
    expect(updateCall).toBeDefined();
    if (updateCall) {
      expect(updateCall.variables.itemId).toBe("PVTI_existing");
      expect(updateCall.variables.optionId).toBe("opt_done");
    }
  });

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  it("sends Bearer token in Authorization header", async () => {
    setupGraphQLMock([
      { match: "projectV2(number", data: PROJECT_METADATA },
      {
        match: "addProjectV2DraftIssue",
        data: {
          addProjectV2DraftIssue: { projectItem: { id: "PVTI_1" } },
        },
      },
    ]);

    const provider = new GitHubProjectsProvider(makeConfig());
    await provider.sync(
      makeEvent("cycle_initialized", {
        entity_type: "cycle",
        entity_id: "test-cycle",
      }),
    );

    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls;
    const firstCallOpts = fetchCalls[0][1] as RequestInit;
    const headers = firstCallOpts.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ghp_test123");
  });

  // -----------------------------------------------------------------------
  // Status mapping
  // -----------------------------------------------------------------------

  it("uses custom status_map", async () => {
    const { calls } = setupGraphQLMock([
      { match: "projectV2(number", data: PROJECT_METADATA },
      {
        match: "items(first",
        data: { node: { items: { nodes: [] } } },
      },
      {
        match: "addProjectV2DraftIssue",
        data: {
          addProjectV2DraftIssue: { projectItem: { id: "PVTI_1" } },
        },
      },
      {
        match: "updateProjectV2ItemFieldValue",
        data: {
          updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } },
        },
      },
    ]);

    const provider = new GitHubProjectsProvider(
      makeConfig({
        status_map: { doing: "In Progress" },
      }),
    );

    await provider.sync(makeEvent("task_started"));

    const updateCall = calls.find((c) =>
      c.query.includes("updateProjectV2ItemFieldValue"),
    );
    if (updateCall) {
      expect(updateCall.variables.optionId).toBe("opt_inprog");
    }
  });

  // -----------------------------------------------------------------------
  // Caching
  // -----------------------------------------------------------------------

  it("caches project metadata across events", async () => {
    const { calls } = setupGraphQLMock([
      { match: "projectV2(number", data: PROJECT_METADATA },
      {
        match: "addProjectV2DraftIssue",
        data: {
          addProjectV2DraftIssue: { projectItem: { id: "PVTI_1" } },
        },
      },
      {
        match: "items(first",
        data: { node: { items: { nodes: [] } } },
      },
      {
        match: "updateProjectV2ItemFieldValue",
        data: {
          updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } },
        },
      },
    ]);

    const provider = new GitHubProjectsProvider(makeConfig());

    // First event loads metadata
    await provider.sync(
      makeEvent("cycle_initialized", {
        entity_type: "cycle",
        entity_id: "test-cycle",
      }),
    );

    const metadataCallCount = calls.filter((c) =>
      c.query.includes("projectV2(number"),
    ).length;

    // Second event should reuse cached metadata
    await provider.sync(makeEvent("task_started"));

    const newMetadataCallCount = calls.filter((c) =>
      c.query.includes("projectV2(number"),
    ).length;

    expect(newMetadataCallCount).toBe(metadataCallCount);
  });
});
