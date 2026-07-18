/**
 * WebhookProvider — POSTs SyncEvents as JSON to a configured URL.
 *
 * Uses Node.js built-in fetch (Node 18+). No external HTTP library needed.
 */

import type { SyncEvent, SyncEventType, SyncProvider } from "../schema.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface WebhookProviderConfig {
  /** Provider name. Defaults to "webhook:<url-hostname>". */
  name?: string;
  /** Target URL to POST events to. */
  url: string;
  /** Extra headers (e.g. auth tokens). Supports ${VAR} env var interpolation. */
  headers?: Record<string, string>;
  /** HTTP method — POST or PUT. Default: POST. */
  method?: "POST" | "PUT";
  /** Per-request timeout in milliseconds. Default: 10000. */
  timeout_ms?: number;
  /** Event type allowlist — when set, only matching events fire the webhook. */
  events?: SyncEventType[];
}

// ---------------------------------------------------------------------------
// Env var interpolation
// ---------------------------------------------------------------------------

/**
 * Replace ${VAR_NAME} patterns with process.env[VAR_NAME].
 * Throws at construction time if a referenced env var is missing.
 */
export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const envVal = process.env[varName];
    if (envVal === undefined) {
      throw new Error(
        `Environment variable "${varName}" is not set (referenced in webhook config)`,
      );
    }
    return envVal;
  });
}

// ---------------------------------------------------------------------------
// WebhookProvider
// ---------------------------------------------------------------------------

export class WebhookProvider implements SyncProvider {
  readonly name: string;
  readonly events?: SyncEventType[];

  private readonly url: string;
  private readonly method: "POST" | "PUT";
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(config: WebhookProviderConfig) {
    // Resolve env vars in URL
    this.url = resolveEnvVars(config.url);

    // Derive name from hostname if not specified
    this.name = config.name ?? `webhook:${new URL(this.url).hostname}`;
    this.method = config.method ?? "POST";
    this.timeoutMs = config.timeout_ms ?? 10_000;
    this.events = config.events;

    // Resolve env vars in all header values at construction time
    this.headers = {};
    if (config.headers) {
      for (const [key, value] of Object.entries(config.headers)) {
        this.headers[key] = resolveEnvVars(value);
      }
    }
  }

  async sync(event: SyncEvent): Promise<void> {
    const response = await fetch(this.url, {
      method: this.method,
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(no body)");
      const snippet = body.length > 200 ? body.slice(0, 200) + "..." : body;
      throw new Error(
        `Webhook returned ${response.status} ${response.statusText}: ${snippet}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWebhookProvider(
  config: WebhookProviderConfig,
): SyncProvider {
  return new WebhookProvider(config);
}
