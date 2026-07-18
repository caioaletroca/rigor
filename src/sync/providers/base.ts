/**
 * BaseProvider — abstract base class for sync providers.
 *
 * Handles common concerns:
 * - Env-var interpolation for auth fields
 * - Configurable retry with exponential backoff
 * - Structured error reporting
 * - Status mapping (Rigor status -> platform status)
 * - Entity mapping (Rigor entity type -> platform entity type)
 *
 * Writing a new provider requires only implementing:
 * - `handleEvent(event)` — the platform-specific API call
 */

import type { SyncEvent, SyncEventType, SyncProvider } from "../schema.js";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface BaseProviderConfig {
  /** Provider instance name. */
  name: string;
  /** Optional event type allowlist. */
  events?: SyncEventType[];
  /** Max retry attempts for transient errors. Default: 2 (total 3 attempts). */
  max_retries?: number;
  /** Base delay for exponential backoff in ms. Default: 1000. */
  retry_delay_ms?: number;
  /** Status mapping: Rigor status -> platform status string. */
  status_map?: Record<string, string>;
  /** Entity mapping: Rigor entity type -> platform entity type string. */
  entity_map?: Record<string, string>;
}

/** Result from a provider's handleEvent implementation. */
export interface ProviderEventResult {
  /** Whether the operation succeeded. */
  success: boolean;
  /** Optional external ID (e.g. Jira issue key, GitHub item ID). */
  external_id?: string;
  /** Optional external URL. */
  external_url?: string;
}

// ---------------------------------------------------------------------------
// Env var interpolation
// ---------------------------------------------------------------------------

/**
 * Replace ${VAR_NAME} patterns with process.env[VAR_NAME].
 * Throws if a referenced env var is missing.
 */
export function resolveEnvVar(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const envVal = process.env[varName];
    if (envVal === undefined) {
      throw new Error(
        `Environment variable "${varName}" is not set (referenced in provider config)`,
      );
    }
    return envVal;
  });
}

// ---------------------------------------------------------------------------
// BaseProvider
// ---------------------------------------------------------------------------

export abstract class BaseProvider implements SyncProvider {
  readonly name: string;
  readonly events?: SyncEventType[];

  protected readonly maxRetries: number;
  protected readonly retryDelayMs: number;
  protected readonly statusMap: Record<string, string>;
  protected readonly entityMap: Record<string, string>;

  constructor(config: BaseProviderConfig) {
    this.name = config.name;
    this.events = config.events;
    this.maxRetries = config.max_retries ?? 2;
    this.retryDelayMs = config.retry_delay_ms ?? 1000;
    this.statusMap = config.status_map ?? this.defaultStatusMap();
    this.entityMap = config.entity_map ?? this.defaultEntityMap();
  }

  /**
   * Main sync method — retries on transient errors.
   * Delegates to handleEvent() for the actual platform call.
   */
  async sync(event: SyncEvent): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.handleEvent(event);
        return;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!this.isRetryable(lastError) || attempt === this.maxRetries) {
          break;
        }

        // Exponential backoff: delay * 2^attempt
        const delay = this.retryDelayMs * Math.pow(2, attempt);
        await sleep(delay);
      }
    }

    throw lastError;
  }

  // -----------------------------------------------------------------------
  // Abstract methods (implement in subclass)
  // -----------------------------------------------------------------------

  /**
   * Handle a single event — the platform-specific API call.
   * Throw on failure; the base class handles retry.
   */
  protected abstract handleEvent(event: SyncEvent): Promise<void>;

  // -----------------------------------------------------------------------
  // Overridable defaults
  // -----------------------------------------------------------------------

  /**
   * Default status mapping. Override in subclass for platform defaults.
   * Maps Rigor Status values to platform-specific status strings.
   */
  protected defaultStatusMap(): Record<string, string> {
    return {
      pending: "To Do",
      doing: "In Progress",
      done: "Done",
      failed: "Blocked",
    };
  }

  /**
   * Default entity mapping. Override in subclass for platform defaults.
   * Maps Rigor entity types to platform-specific entity types.
   */
  protected defaultEntityMap(): Record<string, string> {
    return {
      cycle: "epic",
      phase: "milestone",
      epic: "story",
      task: "subtask",
    };
  }

  /**
   * Determine whether an error is retryable (transient).
   * Override to customize retry behavior.
   *
   * Default: retries on network errors and 5xx/429 status codes.
   */
  protected isRetryable(error: Error): boolean {
    const msg = error.message.toLowerCase();

    // Network errors
    if (
      msg.includes("fetch failed") ||
      msg.includes("econnrefused") ||
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("network")
    ) {
      return true;
    }

    // HTTP 5xx or 429 (rate limit)
    const statusMatch = msg.match(/returned (\d+)/);
    if (statusMatch) {
      const status = parseInt(statusMatch[1], 10);
      return status >= 500 || status === 429;
    }

    return false;
  }

  // -----------------------------------------------------------------------
  // Helpers for subclasses
  // -----------------------------------------------------------------------

  /** Map a Rigor status to the platform's status string. */
  protected mapStatus(status: string): string {
    return this.statusMap[status] ?? status;
  }

  /** Map a Rigor entity type to the platform's entity type. */
  protected mapEntityType(entityType: string): string {
    return this.entityMap[entityType] ?? entityType;
  }

  /**
   * Resolve env vars in a string value. Throws if a referenced var is missing.
   * Call at construction time to fail fast on misconfiguration.
   */
  protected resolveEnv(value: string): string {
    return resolveEnvVar(value);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
