/**
 * Sync providers barrel export.
 */

export { BaseProvider, resolveEnvVar } from "./base.js";
export type { BaseProviderConfig, ProviderEventResult } from "./base.js";
export { WebhookProvider, createWebhookProvider, resolveEnvVars } from "./webhook.js";
export type { WebhookProviderConfig } from "./webhook.js";
export { JiraProvider, createJiraProvider } from "./jira.js";
export type { JiraProviderConfig } from "./jira.js";
export { GitHubProjectsProvider, createGitHubProjectsProvider } from "./github-projects.js";
export type { GitHubProjectsProviderConfig } from "./github-projects.js";
