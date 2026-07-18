/**
 * Provider factory — builds SyncProvider instances from config.
 *
 * Extension point for new providers: add a case to the switch.
 */

import type { SyncProvider, SyncEventType } from "./schema.js";
import type { SyncConfig } from "../config/schema.js";
import { createWebhookProvider } from "./providers/webhook.js";
import { createJiraProvider } from "./providers/jira.js";
import { createGitHubProjectsProvider } from "./providers/github-projects.js";

/**
 * Build provider instances from the sync config's provider map.
 *
 * Iterates entries, switches on `type` field:
 *   "webhook"          -> WebhookProvider
 *   "jira"             -> JiraProvider
 *   "github-projects"  -> GitHubProjectsProvider
 *   unknown            -> logged warning, skipped
 */
export function createProviders(syncConfig: SyncConfig): SyncProvider[] {
  const providers: SyncProvider[] = [];

  for (const [name, config] of Object.entries(syncConfig.providers)) {
    const { type, events, ...rest } = config;

    try {
      switch (type) {
        case "webhook": {
          providers.push(
            createWebhookProvider({
              name,
              events: events as SyncEventType[] | undefined,
              ...rest,
              url: rest.url as string,
              headers: rest.headers as Record<string, string> | undefined,
              method: rest.method as "POST" | "PUT" | undefined,
              timeout_ms: rest.timeout_ms as number | undefined,
            }),
          );
          break;
        }
        case "jira": {
          providers.push(
            createJiraProvider({
              name,
              events: events as SyncEventType[] | undefined,
              base_url: rest.base_url as string,
              email: rest.email as string,
              token: rest.token as string,
              project_key: rest.project_key as string,
              timeout_ms: rest.timeout_ms as number | undefined,
              max_retries: rest.max_retries as number | undefined,
              retry_delay_ms: rest.retry_delay_ms as number | undefined,
              status_map: rest.status_map as Record<string, string> | undefined,
              entity_map: rest.entity_map as Record<string, string> | undefined,
            }),
          );
          break;
        }
        case "github-projects": {
          providers.push(
            createGitHubProjectsProvider({
              name,
              events: events as SyncEventType[] | undefined,
              owner: rest.owner as string,
              repo: rest.repo as string,
              project_number: rest.project_number as number,
              token: rest.token as string,
              api_url: rest.api_url as string | undefined,
              timeout_ms: rest.timeout_ms as number | undefined,
              max_retries: rest.max_retries as number | undefined,
              retry_delay_ms: rest.retry_delay_ms as number | undefined,
              status_map: rest.status_map as Record<string, string> | undefined,
              entity_map: rest.entity_map as Record<string, string> | undefined,
              status_field_name: rest.status_field_name as string | undefined,
            }),
          );
          break;
        }
        default:
          process.stderr.write(
            `[rigor:sync] unknown provider type "${type}" for "${name}" — skipping\n`,
          );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[rigor:sync] failed to create provider "${name}" (${type}): ${message}\n`,
      );
    }
  }

  return providers;
}
