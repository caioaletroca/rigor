/**
 * JiraProvider — syncs Rigor lifecycle events to Jira Cloud via REST API v3.
 *
 * Capabilities:
 * - cycle_initialized: creates Jira issues matching the configured entity mapping
 * - task/epic/phase transitions: updates issue status via transitions API
 *
 * Auth: email + API token (Basic auth), from global config or env vars.
 *
 * Entity mapping defaults:
 *   cycle -> epic, phase -> milestone (label), epic -> story, task -> sub-task
 *
 * Status mapping defaults:
 *   pending -> "To Do", doing -> "In Progress", done -> "Done", failed -> "Blocked"
 */

import { BaseProvider } from "./base.js";
import type { BaseProviderConfig } from "./base.js";
import type { SyncEvent, SyncEventType } from "../schema.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface JiraProviderConfig extends BaseProviderConfig {
  /** Jira Cloud base URL (e.g. https://mycompany.atlassian.net). */
  base_url: string;
  /** Jira user email for Basic auth. Supports ${VAR} interpolation. */
  email: string;
  /** Jira API token. Supports ${VAR} interpolation. */
  token: string;
  /** Jira project key (e.g. "RIG"). */
  project_key: string;
  /** Per-request timeout in ms. Default: 15000. */
  timeout_ms?: number;
}

// ---------------------------------------------------------------------------
// JiraProvider
// ---------------------------------------------------------------------------

export class JiraProvider extends BaseProvider {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly projectKey: string;
  private readonly timeoutMs: number;

  constructor(config: JiraProviderConfig) {
    super({
      ...config,
      // Jira-specific retry defaults
      max_retries: config.max_retries ?? 2,
      retry_delay_ms: config.retry_delay_ms ?? 1000,
    });

    this.baseUrl = this.resolveEnv(config.base_url).replace(/\/+$/, "");
    const email = this.resolveEnv(config.email);
    const token = this.resolveEnv(config.token);
    this.authHeader =
      "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
    this.projectKey = config.project_key;
    this.timeoutMs = config.timeout_ms ?? 15_000;
  }

  // -----------------------------------------------------------------------
  // Override defaults for Jira
  // -----------------------------------------------------------------------

  protected override defaultStatusMap(): Record<string, string> {
    return {
      pending: "To Do",
      doing: "In Progress",
      done: "Done",
      failed: "Blocked",
    };
  }

  protected override defaultEntityMap(): Record<string, string> {
    return {
      cycle: "Epic",
      phase: "Epic",
      epic: "Story",
      task: "Sub-task",
    };
  }

  // -----------------------------------------------------------------------
  // Event handling
  // -----------------------------------------------------------------------

  protected override async handleEvent(event: SyncEvent): Promise<void> {
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
  // Jira API calls
  // -----------------------------------------------------------------------

  /**
   * On cycle_initialized, add a comment to an existing issue or create one.
   * We search for an issue with the cycle_id in the summary first.
   */
  private async handleCycleInitialized(event: SyncEvent): Promise<void> {
    // Try to find an existing issue for this cycle
    const existing = await this.findIssue(event.cycle_id);

    if (existing) {
      // Add a comment noting the cycle was re-initialized
      await this.addComment(
        existing,
        `Rigor cycle "${event.cycle_id}" initialized at ${event.timestamp}.`,
      );
    } else {
      // Create a new epic-level issue for the cycle
      await this.createIssue({
        summary: `[Rigor] ${event.cycle_id}`,
        description: `Rigor development cycle initialized at ${event.timestamp}.`,
        issueType: this.mapEntityType("cycle"),
      });
    }
  }

  /**
   * On entity transitions, find the matching issue and attempt to
   * transition it to the mapped status.
   */
  private async handleTransition(event: SyncEvent): Promise<void> {
    if (!event.new_status) return;

    const searchKey = `${event.cycle_id}/${event.entity_id}`;
    const issueKey = await this.findIssue(searchKey);

    if (!issueKey) {
      // No matching issue — create one with the right status
      await this.createIssue({
        summary: `[Rigor] ${searchKey}`,
        description: `Rigor ${event.entity_type} ${event.entity_id} — ${event.type}`,
        issueType: this.mapEntityType(event.entity_type),
      });
      return;
    }

    // Find the transition ID that matches the target status
    const targetStatus = this.mapStatus(event.new_status);
    const transitionId = await this.findTransition(issueKey, targetStatus);

    if (transitionId) {
      await this.transitionIssue(issueKey, transitionId);
    } else {
      // Can't transition — add a comment instead
      await this.addComment(
        issueKey,
        `Rigor: ${event.entity_type} ${event.entity_id} transitioned to "${event.new_status}" (mapped: "${targetStatus}").`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Jira REST API helpers
  // -----------------------------------------------------------------------

  private async jiraFetch(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const url = `${this.baseUrl}/rest/api/3${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(options.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(no body)");
      const snippet = body.length > 200 ? body.slice(0, 200) + "..." : body;
      throw new Error(
        `Jira API returned ${response.status} ${response.statusText}: ${snippet}`,
      );
    }

    return response;
  }

  private async findIssue(searchText: string): Promise<string | null> {
    const jql = `project = "${this.projectKey}" AND summary ~ "${searchText}" ORDER BY created DESC`;
    const response = await this.jiraFetch(
      `/search?jql=${encodeURIComponent(jql)}&maxResults=1&fields=key`,
    );
    const data = (await response.json()) as {
      issues: Array<{ key: string }>;
    };

    return data.issues.length > 0 ? data.issues[0].key : null;
  }

  private async createIssue(params: {
    summary: string;
    description: string;
    issueType: string;
  }): Promise<string> {
    const response = await this.jiraFetch("/issue", {
      method: "POST",
      body: JSON.stringify({
        fields: {
          project: { key: this.projectKey },
          summary: params.summary,
          description: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: params.description }],
              },
            ],
          },
          issuetype: { name: params.issueType },
        },
      }),
    });

    const data = (await response.json()) as { key: string };
    return data.key;
  }

  private async findTransition(
    issueKey: string,
    targetStatusName: string,
  ): Promise<string | null> {
    const response = await this.jiraFetch(
      `/issue/${issueKey}/transitions`,
    );
    const data = (await response.json()) as {
      transitions: Array<{ id: string; name: string; to: { name: string } }>;
    };

    const match = data.transitions.find(
      (t) =>
        t.name.toLowerCase() === targetStatusName.toLowerCase() ||
        t.to.name.toLowerCase() === targetStatusName.toLowerCase(),
    );

    return match ? match.id : null;
  }

  private async transitionIssue(
    issueKey: string,
    transitionId: string,
  ): Promise<void> {
    await this.jiraFetch(`/issue/${issueKey}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
  }

  private async addComment(
    issueKey: string,
    text: string,
  ): Promise<void> {
    await this.jiraFetch(`/issue/${issueKey}/comment`, {
      method: "POST",
      body: JSON.stringify({
        body: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text }],
            },
          ],
        },
      }),
    });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createJiraProvider(config: JiraProviderConfig): JiraProvider {
  return new JiraProvider(config);
}
