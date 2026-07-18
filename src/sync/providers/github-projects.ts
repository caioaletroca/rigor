/**
 * GitHubProjectsProvider — syncs Rigor lifecycle events to GitHub Projects v2
 * via the GraphQL API.
 *
 * Capabilities:
 * - cycle_initialized: creates a project item (draft issue)
 * - transitions: updates the status custom field on the project item
 *
 * Auth: GitHub PAT (classic or fine-grained), from config or env vars.
 *
 * Entity mapping defaults:
 *   cycle -> project, epic -> issue, task -> task-list-item
 */

import { BaseProvider } from "./base.js";
import type { BaseProviderConfig } from "./base.js";
import type { SyncEvent } from "../schema.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GitHubProjectsProviderConfig extends BaseProviderConfig {
  /** GitHub org or user that owns the project. */
  owner: string;
  /** Repository name (for linking). */
  repo: string;
  /** Project number (visible in the project URL). */
  project_number: number;
  /** GitHub PAT. Supports ${VAR} interpolation. */
  token: string;
  /** GitHub API URL. Default: https://api.github.com. */
  api_url?: string;
  /** Per-request timeout in ms. Default: 15000. */
  timeout_ms?: number;
  /** Name of the Status field in the project. Default: "Status". */
  status_field_name?: string;
}

// ---------------------------------------------------------------------------
// GraphQL response types
// ---------------------------------------------------------------------------

interface ProjectV2 {
  id: string;
  fields: {
    nodes: Array<{
      id: string;
      name: string;
      options?: Array<{ id: string; name: string }>;
    }>;
  };
}

interface ProjectItem {
  id: string;
}

// ---------------------------------------------------------------------------
// GitHubProjectsProvider
// ---------------------------------------------------------------------------

export class GitHubProjectsProvider extends BaseProvider {
  private readonly owner: string;
  private readonly repo: string;
  private readonly projectNumber: number;
  private readonly token: string;
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly statusFieldName: string;

  // Cached project metadata (lazy-loaded)
  private projectId?: string;
  private statusFieldId?: string;
  private statusOptions?: Map<string, string>;

  constructor(config: GitHubProjectsProviderConfig) {
    super({
      ...config,
      max_retries: config.max_retries ?? 2,
      retry_delay_ms: config.retry_delay_ms ?? 1000,
    });

    this.owner = config.owner;
    this.repo = config.repo;
    this.projectNumber = config.project_number;
    this.token = this.resolveEnv(config.token);
    this.apiUrl = (config.api_url ?? "https://api.github.com").replace(
      /\/+$/,
      "",
    );
    this.timeoutMs = config.timeout_ms ?? 15_000;
    this.statusFieldName = config.status_field_name ?? "Status";
  }

  // -----------------------------------------------------------------------
  // Override defaults for GitHub Projects
  // -----------------------------------------------------------------------

  protected override defaultStatusMap(): Record<string, string> {
    return {
      pending: "Todo",
      doing: "In Progress",
      done: "Done",
      failed: "Blocked",
    };
  }

  protected override defaultEntityMap(): Record<string, string> {
    return {
      cycle: "project",
      phase: "milestone",
      epic: "issue",
      task: "task-list-item",
    };
  }

  // -----------------------------------------------------------------------
  // Event handling
  // -----------------------------------------------------------------------

  protected override async handleEvent(event: SyncEvent): Promise<void> {
    // Ensure project metadata is loaded
    await this.ensureProjectMetadata();

    switch (event.type) {
      case "cycle_initialized":
        await this.handleCycleInitialized(event);
        break;
      case "task_started":
      case "task_completed":
      case "task_failed":
      case "epic_started":
      case "epic_completed":
      case "epic_failed":
      case "phase_started":
      case "phase_completed":
      case "phase_failed":
        await this.handleTransition(event);
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------------

  private async handleCycleInitialized(event: SyncEvent): Promise<void> {
    await this.addDraftItem(
      `[Rigor] ${event.cycle_id}`,
    );
  }

  private async handleTransition(event: SyncEvent): Promise<void> {
    if (!event.new_status) return;

    const title = `[Rigor] ${event.cycle_id}/${event.entity_id}`;

    // Try to find an existing item
    let itemId = await this.findItemByTitle(title);

    if (!itemId) {
      // Create a draft item
      itemId = await this.addDraftItem(title);
    }

    // Update the status field
    const targetStatus = this.mapStatus(event.new_status);
    await this.updateItemStatus(itemId, targetStatus);
  }

  // -----------------------------------------------------------------------
  // GraphQL operations
  // -----------------------------------------------------------------------

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const response = await fetch(`${this.apiUrl}/graphql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(no body)");
      throw new Error(
        `GitHub API returned ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    const result = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };

    if (result.errors && result.errors.length > 0) {
      throw new Error(
        `GitHub GraphQL errors: ${result.errors.map((e) => e.message).join(", ")}`,
      );
    }

    if (!result.data) {
      throw new Error("GitHub GraphQL returned no data");
    }

    return result.data;
  }

  private async ensureProjectMetadata(): Promise<void> {
    if (this.projectId) return;

    const query = `
      query($owner: String!, $number: Int!) {
        user(login: $owner) {
          projectV2(number: $number) {
            id
            fields(first: 20) {
              nodes {
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options { id name }
                }
                ... on ProjectV2Field {
                  id
                  name
                }
              }
            }
          }
        }
        organization(login: $owner) {
          projectV2(number: $number) {
            id
            fields(first: 20) {
              nodes {
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options { id name }
                }
                ... on ProjectV2Field {
                  id
                  name
                }
              }
            }
          }
        }
      }
    `;

    const data = await this.graphql<{
      user?: { projectV2: ProjectV2 | null };
      organization?: { projectV2: ProjectV2 | null };
    }>(query, { owner: this.owner, number: this.projectNumber });

    const project =
      data.user?.projectV2 ?? data.organization?.projectV2;

    if (!project) {
      throw new Error(
        `Project #${this.projectNumber} not found for owner "${this.owner}"`,
      );
    }

    this.projectId = project.id;

    // Find the Status field
    const statusField = project.fields.nodes.find(
      (f) => f.name === this.statusFieldName,
    );
    if (statusField) {
      this.statusFieldId = statusField.id;
      this.statusOptions = new Map(
        (statusField.options ?? []).map((o) => [
          o.name.toLowerCase(),
          o.id,
        ]),
      );
    }
  }

  private async addDraftItem(title: string): Promise<string> {
    const mutation = `
      mutation($projectId: ID!, $title: String!) {
        addProjectV2DraftIssue(input: {
          projectId: $projectId
          title: $title
        }) {
          projectItem { id }
        }
      }
    `;

    const data = await this.graphql<{
      addProjectV2DraftIssue: { projectItem: ProjectItem };
    }>(mutation, { projectId: this.projectId!, title });

    return data.addProjectV2DraftIssue.projectItem.id;
  }

  private async findItemByTitle(title: string): Promise<string | null> {
    // GitHub Projects v2 doesn't have a direct title search.
    // We list recent items and match. For large projects this is imperfect
    // but adequate for sync use cases.
    const query = `
      query($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 100) {
              nodes {
                id
                content {
                  ... on DraftIssue { title }
                  ... on Issue { title }
                  ... on PullRequest { title }
                }
              }
            }
          }
        }
      }
    `;

    const data = await this.graphql<{
      node: {
        items: {
          nodes: Array<{
            id: string;
            content: { title?: string } | null;
          }>;
        };
      };
    }>(query, { projectId: this.projectId! });

    const match = data.node.items.nodes.find(
      (item) => item.content?.title === title,
    );

    return match?.id ?? null;
  }

  private async updateItemStatus(
    itemId: string,
    statusName: string,
  ): Promise<void> {
    if (!this.statusFieldId || !this.statusOptions) {
      return; // No status field configured
    }

    const optionId = this.statusOptions.get(statusName.toLowerCase());
    if (!optionId) {
      return; // Status option not found — skip silently
    }

    const mutation = `
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { singleSelectOptionId: $optionId }
        }) {
          projectV2Item { id }
        }
      }
    `;

    await this.graphql(mutation, {
      projectId: this.projectId!,
      itemId,
      fieldId: this.statusFieldId,
      optionId,
    });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGitHubProjectsProvider(
  config: GitHubProjectsProviderConfig,
): GitHubProjectsProvider {
  return new GitHubProjectsProvider(config);
}
