/**
 * SyncManager — dispatches lifecycle events to registered providers
 * and journals every event to disk.
 *
 * Pattern follows EvidenceManager: takes projectRoot, creates a directory
 * under .rigor/, writes structured files.
 *
 * Features:
 * - Fire-and-forget dispatch to N providers concurrently
 * - Event journal (append-only JSON Lines) for auditability
 * - Retry: re-dispatch the last N failed events to a named provider
 * - Replay: replay all journal events to a specific provider
 * - Health tracking: per-provider success/failure counters + circuit breaker
 */

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { shouldDispatch } from "./schema.js";
import type { SyncEvent, SyncProvider, SyncResult } from "./schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RIGOR_DIR = ".rigor";
const SYNC_DIR = "sync";
const JOURNAL_FILE = "events.jsonl";

/** Default per-provider timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Default consecutive failures before circuit breaker trips. */
const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Health types
// ---------------------------------------------------------------------------

export interface ProviderHealth {
  name: string;
  total_dispatches: number;
  successes: number;
  failures: number;
  consecutive_failures: number;
  circuit_open: boolean;
  last_error?: string;
  last_success_at?: string;
  last_failure_at?: string;
}

// ---------------------------------------------------------------------------
// SyncManager
// ---------------------------------------------------------------------------

export class SyncManager {
  private readonly syncDir: string;
  private readonly journalPath: string;
  private readonly circuitBreakerThreshold: number;

  /** Per-provider health state. */
  private readonly health: Map<
    string,
    {
      total: number;
      successes: number;
      failures: number;
      consecutiveFailures: number;
      circuitOpen: boolean;
      lastError?: string;
      lastSuccessAt?: string;
      lastFailureAt?: string;
    }
  > = new Map();

  /** Set of provider names disabled by the circuit breaker. */
  private readonly disabledProviders: Set<string> = new Set();

  constructor(
    projectRoot: string,
    private readonly providers: SyncProvider[],
    private readonly primaryName?: string,
    circuitBreakerThreshold?: number,
  ) {
    this.syncDir = join(projectRoot, RIGOR_DIR, SYNC_DIR);
    this.journalPath = join(this.syncDir, JOURNAL_FILE);
    this.circuitBreakerThreshold =
      circuitBreakerThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;

    if (!existsSync(this.syncDir)) {
      mkdirSync(this.syncDir, { recursive: true });
    }

    // Initialize health for all providers
    for (const p of providers) {
      this.health.set(p.name, {
        total: 0,
        successes: 0,
        failures: 0,
        consecutiveFailures: 0,
        circuitOpen: false,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Core dispatch
  // -----------------------------------------------------------------------

  /**
   * Dispatch an event to all matching providers.
   *
   * 1. Journals the event first (survives provider crashes).
   * 2. Filters providers using shouldDispatch().
   * 3. Skips circuit-broken providers.
   * 4. Fires concurrently with per-provider timeout.
   * 5. Returns SyncResult[] — one per dispatched provider.
   *
   * Never throws.
   */
  async dispatch(event: SyncEvent): Promise<SyncResult[]> {
    // Journal-first: write before dispatching
    this.journal(event);

    // Filter to matching and healthy providers
    const matching = this.providers.filter(
      (p) =>
        shouldDispatch(p, event) && !this.disabledProviders.has(p.name),
    );

    if (matching.length === 0) {
      return [];
    }

    // Dispatch concurrently with per-provider timeout
    const promises = matching.map((provider) =>
      this.dispatchToProvider(provider, event),
    );

    return Promise.all(promises);
  }

  // -----------------------------------------------------------------------
  // Retry and replay
  // -----------------------------------------------------------------------

  /**
   * Retry the last N events from the journal against a named provider.
   *
   * Replays events regardless of the provider's event filter.
   * Returns per-event results.
   */
  async retry(
    providerName: string,
    count: number,
  ): Promise<SyncResult[]> {
    const provider = this.providers.find((p) => p.name === providerName);
    if (!provider) {
      return [
        {
          provider: providerName,
          success: false,
          error: `Provider "${providerName}" not found`,
          duration_ms: 0,
        },
      ];
    }

    const events = this.getJournalEvents();
    const eventsToRetry = events.slice(-count);

    const results: SyncResult[] = [];
    for (const event of eventsToRetry) {
      const result = await this.dispatchToProvider(provider, event);
      results.push(result);
    }

    return results;
  }

  /**
   * Replay all journal events to a named provider.
   *
   * Useful for bootstrapping a new provider against an existing cycle.
   * Returns per-event results.
   */
  async replay(providerName: string): Promise<SyncResult[]> {
    const provider = this.providers.find((p) => p.name === providerName);
    if (!provider) {
      return [
        {
          provider: providerName,
          success: false,
          error: `Provider "${providerName}" not found`,
          duration_ms: 0,
        },
      ];
    }

    const events = this.getJournalEvents();

    const results: SyncResult[] = [];
    for (const event of events) {
      const result = await this.dispatchToProvider(provider, event);
      results.push(result);
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // Health and circuit breaker
  // -----------------------------------------------------------------------

  /**
   * Get health status for all providers.
   */
  getProviderHealth(): ProviderHealth[] {
    return this.providers.map((p) => {
      const h = this.health.get(p.name)!;
      return {
        name: p.name,
        total_dispatches: h.total,
        successes: h.successes,
        failures: h.failures,
        consecutive_failures: h.consecutiveFailures,
        circuit_open: h.circuitOpen,
        last_error: h.lastError,
        last_success_at: h.lastSuccessAt,
        last_failure_at: h.lastFailureAt,
      };
    });
  }

  /**
   * Re-enable a provider that was disabled by the circuit breaker.
   * Returns true if the provider was disabled and is now enabled.
   */
  enableProvider(providerName: string): boolean {
    if (!this.disabledProviders.has(providerName)) {
      return false;
    }

    this.disabledProviders.delete(providerName);
    const h = this.health.get(providerName);
    if (h) {
      h.circuitOpen = false;
      h.consecutiveFailures = 0;
    }
    return true;
  }

  /**
   * Check if a provider is disabled by the circuit breaker.
   */
  isProviderDisabled(providerName: string): boolean {
    return this.disabledProviders.has(providerName);
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /** Returns the path to the journal file. */
  getJournalPath(): string {
    return this.journalPath;
  }

  /** Returns registered provider names. */
  getProviderNames(): string[] {
    return this.providers.map((p) => p.name);
  }

  /** Returns the primary provider name. */
  getPrimaryName(): string | undefined {
    return this.primaryName;
  }

  /** Counts lines in the journal file (= number of events dispatched). */
  getEventCount(): number {
    if (!existsSync(this.journalPath)) {
      return 0;
    }

    const content = readFileSync(this.journalPath, "utf-8");
    if (content.trim() === "") return 0;

    return content.trim().split("\n").length;
  }

  /**
   * Read all events from the journal.
   * Returns parsed SyncEvent objects in order.
   */
  getJournalEvents(): SyncEvent[] {
    if (!existsSync(this.journalPath)) {
      return [];
    }

    const content = readFileSync(this.journalPath, "utf-8").trim();
    if (content === "") return [];

    return content
      .split("\n")
      .map((line) => JSON.parse(line) as SyncEvent);
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /** Append event as a JSON line to the journal file. */
  private journal(event: SyncEvent): void {
    const line = JSON.stringify(event) + "\n";
    appendFileSync(this.journalPath, line, "utf-8");
  }

  /** Dispatch to a single provider with timeout and error handling. */
  private async dispatchToProvider(
    provider: SyncProvider,
    event: SyncEvent,
  ): Promise<SyncResult> {
    const start = Date.now();

    try {
      await Promise.race([
        provider.sync(event),
        timeout(DEFAULT_TIMEOUT_MS),
      ]);

      this.recordSuccess(provider.name);

      return {
        provider: provider.name,
        success: true,
        duration_ms: Date.now() - start,
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[rigor:sync] provider "${provider.name}" failed: ${message}\n`,
      );

      this.recordFailure(provider.name, message);

      return {
        provider: provider.name,
        success: false,
        error: message,
        duration_ms: Date.now() - start,
      };
    }
  }

  /** Record a successful dispatch for health tracking. */
  private recordSuccess(providerName: string): void {
    const h = this.health.get(providerName);
    if (!h) return;

    h.total++;
    h.successes++;
    h.consecutiveFailures = 0;
    h.lastSuccessAt = new Date().toISOString();
  }

  /** Record a failed dispatch and check circuit breaker. */
  private recordFailure(providerName: string, error: string): void {
    const h = this.health.get(providerName);
    if (!h) return;

    h.total++;
    h.failures++;
    h.consecutiveFailures++;
    h.lastError = error;
    h.lastFailureAt = new Date().toISOString();

    // Trip circuit breaker if threshold exceeded
    if (h.consecutiveFailures >= this.circuitBreakerThreshold) {
      h.circuitOpen = true;
      this.disabledProviders.add(providerName);
      process.stderr.write(
        `[rigor:sync] circuit breaker tripped for provider "${providerName}" ` +
          `after ${h.consecutiveFailures} consecutive failures — provider disabled\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

function timeout(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => {
      reject(new Error(`Provider timed out after ${ms}ms`));
    }, ms);
  });
}
