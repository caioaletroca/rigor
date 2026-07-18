# Sync Providers — Project Management Platform Integration

> **For implementers:** This is a rolling-wave plan. Phase 1 tasks are
> dispatch-ready. Later phases are epic-level only — elaborate them against
> the real codebase when execution reaches them.
> This document is the living source of truth — task elaboration for later
> phases is written back into it during execution.

**Goal:** Emit lifecycle events from Rigor's state machine and route them
through pluggable provider adapters to external project management platforms
(Jira, GitHub Projects, or any webhook-capable system), so that
cycle/phase/epic/task status stays synchronized without manual updates.

**Architecture:** An event-driven sync layer sits between `StateManager` and
configured providers. `StateManager.transition()` emits a `SyncEvent` to the
`SyncManager`, which asynchronously dispatches it to every registered
`SyncProvider`. Providers are loaded via a three-tier config cascade
(env vars > project > global), so credentials live globally or in env vars
while project-specific settings (project key, status mapping) live in the
repo. A `primary` provider designation tells MCP tools which PM platform to
reference for URLs and status. The sync layer is strictly fire-and-forget — a
provider failure never blocks gate progression. Events are journaled to
`.rigor/sync/events.jsonl` for auditability and replay.

**Tech Stack:** TypeScript, Node.js `fetch` (built-in since Node 18+),
MCP SDK (`@modelcontextprotocol/sdk`), JSON Lines for event journal.

## Config Cascade

```
env vars  >  project .rigor/config.yaml  >  global ~/.config/rigor/config.yaml  >  defaults
```

- **Global** (`~/.config/rigor/config.yaml`): provider profiles with credentials
- **Project** (`.rigor/config.yaml`): references profiles by name, adds project-specific overrides
- **Env vars**: override any field — for CI/CD and secrets managers

```yaml
# ~/.config/rigor/config.yaml (global — never committed)
sync:
  providers:
    my-jira:
      type: jira
      base_url: https://mycompany.atlassian.net
      email: caio@company.com
      token: ${JIRA_API_TOKEN}

# .rigor/config.yaml (project — committed)
sync:
  enabled: true
  primary: my-jira
  providers:
    my-jira:                        # merges over global profile
      project_key: RIG
      status_map:
        doing: "In Progress"
        done: "Done"
        failed: "Blocked"
    slack-hook:
      type: webhook
      url: https://hooks.slack.com/...
      events: [task_completed, epic_completed]  # only these events
```

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | State transitions fire events end-to-end; config cascade merges global+project; webhook provider POSTs to a configured URL; events journaled to disk; `sync_status` MCP tool works | 1.1, 1.2, 1.3, 1.4 | Done |
| 2 | Jira and GitHub Projects providers ship with configurable entity/status mapping; BaseProvider SDK makes writing new providers trivial | 2.1, 2.2, 2.3 | Done |
| 3 | Sync MCP tools for retry/replay; provider health monitoring | 3.1, 3.2 | Done |

---

## Phase 1: Event Core + Config Cascade + Webhook Provider

### Epic 1.1: Event Schema, Provider Interface, and SyncManager

**Goal:** A `SyncManager` class exists that accepts lifecycle events and
dispatches them to an array of `SyncProvider` implementations, journaling
every event to disk regardless of provider outcome. Per-provider event
filtering is supported via an `events` allowlist.
**Scope:** `src/sync/` (new directory)
**Dependencies:** none
**Done when:**
- `SyncEvent` type covers all entity transitions (task/epic/phase started,
  completed, failed) plus `cycle_initialized`
- `SyncProvider` interface has `name`, `sync(event): Promise<void>`, and
  optional `events?: SyncEventType[]` filter
- `SyncManager` dispatches events to matching providers concurrently, catches
  and logs per-provider errors without propagating them
- Events are appended to `.rigor/sync/events.jsonl` on every dispatch
- Unit tests cover: dispatch to multiple providers, one provider failure
  does not affect others, journal file written correctly, event filtering
**Status:** Done

#### Task 1.1.1: Define SyncEvent type and SyncProvider interface

- [x] Done

**Context:** Rigor's state machine uses `Status = "pending" | "doing" | "done" | "failed"` defined in `src/state/schema.ts:12`. Transitions are validated by `isValidTransition()` at `src/state/schema.ts:22-27`. The `StateManager.transition()` method at `src/state/manager.ts:137-155` is the single chokepoint where all status changes happen — it resolves the entity, validates the transition, mutates, and saves. The entity hierarchy is `CycleState > PhaseState > EpicState > TaskState`.

**Implementation vision:** Create `src/sync/schema.ts` with:

- `SyncEventType` union: `"cycle_initialized" | "task_started" | "task_completed" | "task_failed" | "epic_started" | "epic_completed" | "epic_failed" | "phase_started" | "phase_completed" | "phase_failed"`. Map `Status` transitions to event types: `doing` = started, `done` = completed, `failed` = failed.
- `SyncEvent` interface: `{ type: SyncEventType; entity_type: "cycle" | "phase" | "epic" | "task"; entity_id: string; cycle_id: string; timestamp: string; previous_status?: Status; new_status?: Status; metadata?: Record<string, unknown> }`. Metadata carries context like task name, epic goal, phase milestone — whatever the provider needs for a rich update.
- `SyncProvider` interface: `{ name: string; events?: SyncEventType[]; sync(event: SyncEvent): Promise<void> }`. The optional `events` array is an allowlist — when set, only matching event types are dispatched to this provider. When absent, the provider receives all events.
- `SyncResult` interface for per-provider outcomes: `{ provider: string; success: boolean; error?: string; duration_ms: number }`.
- Helper `shouldDispatch(provider: SyncProvider, event: SyncEvent): boolean` — returns true if the provider has no filter or the event type is in the filter list.

Keep this file pure types + the tiny `shouldDispatch` helper — no heavy runtime logic.

**Files:**
- Create: `src/sync/schema.ts`
- Test: `src/sync/schema.test.ts` (type-level validation: construct events, assert shape; shouldDispatch filtering logic)

**Verification:** `npm test -- --run src/sync/schema.test.ts` passes.

**Done when:** Types compile, are importable, tests confirm event construction for every `SyncEventType`, and `shouldDispatch` correctly filters.

---

#### Task 1.1.2: Implement SyncManager with journal and multi-provider dispatch

- [x] Done

**Context:** The pattern to follow is `EvidenceManager` at `src/evidence/manager.ts:1-97` — a class that takes `projectRoot` in its constructor, creates a directory under `.rigor/`, and writes structured files. Evidence uses JSON files per gate; the sync journal should use JSON Lines (one JSON object per line, append-only) for streaming writes.

**Implementation vision:** Create `src/sync/manager.ts` with a `SyncManager` class:

- Constructor: `(projectRoot: string, providers: SyncProvider[], primaryName?: string)`. Creates `.rigor/sync/` directory if missing. Stores `primaryName` for tooling queries.
- `async dispatch(event: SyncEvent): Promise<SyncResult[]>`: the core method. (1) Appends the event as a JSON line to `events.jsonl` immediately (journal-first, so events survive provider crashes). (2) Filters providers using `shouldDispatch()`. (3) Fires `Promise.allSettled()` over matching providers' `sync(event)`, wrapping each in a per-provider timeout (default 10s). (4) Returns an array of `SyncResult` — one per dispatched provider. Logs failures to stderr with provider name and error but never throws.
- `getJournalPath(): string` — returns the path to the journal file.
- `getProviderNames(): string[]` — returns registered provider names.
- `getPrimaryName(): string | undefined` — returns the primary provider name.
- `getEventCount(): number` — counts lines in the journal file.
- The manager is stateless between dispatches: no in-memory queue, no retry.

**Files:**
- Create: `src/sync/manager.ts`
- Test: `src/sync/manager.test.ts`

**Verification:** `npm test -- --run src/sync/manager.test.ts` passes. Tests: (1) dispatch to two mock providers, both succeed — returns two success results; (2) one provider throws — the other still receives the event, failed provider's result has `success: false`; (3) journal file contains the event as a JSON line after dispatch; (4) provider timeout — a provider that hangs beyond 10s gets aborted; (5) event filtering — provider with `events: ["task_completed"]` only receives task_completed events.

**Done when:** `SyncManager` dispatches to N providers concurrently (respecting filters), journals every event, and isolates failures.

---

#### Task 1.1.3: Create barrel export and wire SyncManager into StateManager

- [x] Done

**Context:** `StateManager.transition()` at `src/state/manager.ts:137-155` is where all entity status changes happen. The `init()` method at `src/state/manager.ts:107-122` creates the cycle. These are the two places that should emit events. The server factory at `src/server.ts:40-55` constructs `StateManager` and passes it to tool registration functions.

**Implementation vision:**

1. Create `src/sync/index.ts` barrel that re-exports `SyncManager`, `SyncProvider`, `SyncEvent`, `SyncEventType`, `SyncResult`, `shouldDispatch`.

2. Modify `StateManager` to accept an optional `SyncManager` — add it as an optional constructor parameter with a default of `undefined`. This keeps `StateManager` backward-compatible for tests that don't need sync.

3. In `transition()` (line 152-153), after `entity.status = toStatus` and `this.save(state)`, call `this.syncManager?.dispatch(event)` with `.catch(() => {})` (truly fire-and-forget at this layer — errors are already handled inside SyncManager). Build the `SyncEvent` from the entityId, old status, new status, and `state.cycle_id`.

4. In `init()` (line 120-121), after `this.save(state)`, dispatch a `cycle_initialized` event.

5. The entity type (task/epic/phase) is inferred from the entityId format: dotted with 3 segments = task, 2 = epic, numeric = phase. Use the same logic as `findEntity()` at `src/state/manager.ts:230-258`.

6. Update `ServerContext` at `src/server.ts:27-32` to include `syncManager?: SyncManager`. In `createServer()`, construct `SyncManager` with providers loaded from config (empty array if sync is disabled — Epic 1.3 wires the config).

**Files:**
- Create: `src/sync/index.ts`
- Modify: `src/state/manager.ts:39-52` (constructor), `src/state/manager.ts:137-155` (transition), `src/state/manager.ts:107-122` (init)
- Modify: `src/server.ts:27-32` (ServerContext), `src/server.ts:40-55` (createServer)
- Test: `src/sync/integration.test.ts`

**Verification:** `npm test -- --run src/sync/integration.test.ts` passes. Tests: (1) `StateManager.transition()` with a mock provider — provider receives event with correct type and entity info; (2) `StateManager.init()` fires `cycle_initialized` event; (3) `StateManager` without sync manager works identically to before (backward compat); (4) existing tests still pass: `npm test -- --run src/state/`.

**Done when:** Every state transition emits a `SyncEvent` to all configured providers; existing behavior is unchanged when no sync is configured.

---

### Epic 1.2: Webhook Provider

**Goal:** A `WebhookProvider` implementation ships with Rigor that POSTs
events as JSON to a user-configured URL, making the sync system immediately
usable with any webhook-capable platform.
**Scope:** `src/sync/providers/` (new directory)
**Dependencies:** Epic 1.1
**Done when:**
- `WebhookProvider` POSTs `SyncEvent` as JSON body to a configured URL with
  configurable headers (e.g., auth tokens)
- Provider respects a configurable timeout (default 10s)
- Non-2xx responses are treated as failures (returned in `SyncResult`)
- Env var interpolation in header values (`${VAR}` syntax)
- Optional `events` filter limits which events trigger the webhook
- Unit tests mock `fetch` and verify request shape, headers, error handling
**Status:** Done

#### Task 1.2.1: Implement WebhookProvider

- [x] Done

**Context:** Node.js 18+ has built-in `fetch` — no external HTTP library needed. The `SyncProvider` interface from Task 1.1.1 requires `name: string`, optional `events?: SyncEventType[]`, and `sync(event: SyncEvent): Promise<void>`.

**Implementation vision:** Create `src/sync/providers/webhook.ts`:

- `WebhookProviderConfig`: `{ name?: string; url: string; headers?: Record<string, string>; method?: "POST" | "PUT"; timeout_ms?: number; events?: SyncEventType[] }`. Default method is POST, default timeout 10000ms.
- `WebhookProvider` class implements `SyncProvider`:
  - `name` = config.name or `"webhook:<url-hostname>"` for multi-webhook clarity
  - `events` = config.events (passed through to provider for `shouldDispatch` filtering)
  - `async sync(event)`: calls `fetch(url, { method, headers: { "Content-Type": "application/json", ...resolvedHeaders }, body: JSON.stringify(event), signal: AbortSignal.timeout(timeout_ms) })`. If response is not `ok`, throw with status code and body snippet. The `SyncManager` catches this.
- `resolveEnvVars(value: string): string` — replaces `${VAR_NAME}` patterns with `process.env[VAR_NAME]`. Throws at provider construction time (not at event time) if an env var is missing, so misconfiguration fails loud at startup.
- Export a factory: `createWebhookProvider(config: WebhookProviderConfig): SyncProvider`.

**Files:**
- Create: `src/sync/providers/webhook.ts`
- Create: `src/sync/providers/index.ts` (barrel)
- Test: `src/sync/providers/webhook.test.ts`

**Verification:** `npm test -- --run src/sync/providers/webhook.test.ts` passes. Tests: (1) successful POST — correct URL, headers, JSON body; (2) non-2xx response — sync() rejects with status info; (3) timeout — AbortError after configured ms; (4) env var interpolation in headers; (5) missing env var throws at construction.

**Done when:** `WebhookProvider` sends well-formed HTTP requests for every event type and handles errors gracefully.

---

### Epic 1.3: Config Cascade (Global + Project Merge)

**Goal:** Rigor loads sync configuration from both global
(`~/.config/rigor/config.yaml`) and project (`.rigor/config.yaml`) config
files, merging them with project settings overriding global ones. Env vars
override both. Provider profiles defined globally can be referenced and
extended by project config.
**Scope:** `src/config/`
**Dependencies:** none (can be built in parallel with Epics 1.1 and 1.2)
**Done when:**
- `RigorConfig` has a `sync` section with `enabled`, `primary`, and named `providers` map
- Config loader reads global config from `~/.config/rigor/config.yaml`
- Merge order: defaults < global < project < env vars
- Provider configs merge by name (global defines base, project overrides fields)
- Unit tests verify cascade behavior with all four layers
**Status:** Done

#### Task 1.3.1: Extend RigorConfig with sync section

- [x] Done

**Context:** `RigorConfig` is defined at `src/config/schema.ts:95-99` with three top-level keys: `commit`, `ship`, `gates`. Defaults are at `src/config/schema.ts:105-182`. The config loader at `src/config/loader.ts` deep-merges user YAML over defaults.

**Implementation vision:** Add to `src/config/schema.ts`:

- `SyncProviderConfig`: `{ type: string; events?: string[]; [key: string]: unknown }` — discriminated by `type` field. The `type` drives the factory; all other fields are provider-specific. `events` is the optional allowlist filter.
- `SyncConfig`: `{ enabled: boolean; primary?: string; providers: Record<string, SyncProviderConfig> }`. Providers are a **named map** (not an array) so project config can merge over global config by key. The key is the provider's logical name (e.g., `my-jira`, `slack-hook`).
- Add `sync: SyncConfig` to `RigorConfig` interface (line 98).
- Add default to `DEFAULTS` (line 105): `sync: { enabled: false, providers: {} }`.

The named map is the key design decision — it enables the cascade. An array would force the project to redefine the entire provider list; a map lets it say "take `my-jira` from global and override just `project_key`."

**Files:**
- Modify: `src/config/schema.ts:95-99` (RigorConfig), `src/config/schema.ts:105-182` (DEFAULTS)
- Test: existing config tests should still pass

**Verification:** `npm test -- --run src/config/` passes. TypeScript compiles with the new field.

**Done when:** `RigorConfig` type includes `sync` with proper defaults.

---

#### Task 1.3.2: Config loader with global file merge

- [x] Done

**Context:** The current config loader at `src/config/loader.ts:1-101` only reads from `.rigor/config.yaml` under the project root. It deep-merges user config over `DEFAULTS` using a `deepMerge()` function. The function needs to be extended to also read the global config file.

**Implementation vision:** Modify `src/config/loader.ts`:

1. Add a `getGlobalConfigPath(): string` function that returns the platform-appropriate path: `~/.config/rigor/config.yaml` on Linux/macOS, `%APPDATA%/rigor/config.yaml` on Windows. Use `os.homedir()` + `path.join()` with a platform check.

2. Update `loadConfig(projectRoot)` to:
   - Load global config (if file exists) — parse YAML, ignore if missing
   - Load project config (existing behavior)
   - Merge: `deepMerge(DEFAULTS, globalConfig, projectConfig)`
   - The existing `deepMerge` should already handle three arguments if we apply it sequentially: `deepMerge(deepMerge(DEFAULTS, global), project)`.

3. For the `sync.providers` map specifically: merge is by key. If global defines `my-jira: { type: jira, base_url: ..., token: ... }` and project defines `my-jira: { project_key: RIG }`, the result is all fields merged. This falls out naturally from object deep-merge since providers is `Record<string, object>`.

4. Env var override: support a `RIGOR_SYNC_ENABLED=true` env var to force-enable sync. Provider-level env vars use the `${VAR}` interpolation pattern already built into the webhook provider — they're resolved at provider construction time, not at config load time.

**Files:**
- Modify: `src/config/loader.ts`
- Test: `src/config/loader.test.ts` (add cascade tests)

**Verification:** `npm test -- --run src/config/loader.test.ts` passes. Tests: (1) project-only config works as before; (2) global-only config loaded when project has none; (3) project overrides global fields; (4) providers merge by name across global+project; (5) missing global file is silently ignored.

**Done when:** Config loader reads and merges global + project configs with correct precedence.

---

### Epic 1.4: Server Wiring and MCP Tools

**Goal:** The server constructs `SyncManager` from merged config, passes it
to `StateManager`, and exposes a `sync_status` MCP tool. End-to-end test
proves the full pipeline.
**Scope:** `src/server.ts`, `src/tools/`, `src/sync/`
**Dependencies:** Epics 1.1, 1.2, 1.3
**Done when:**
- `createServer()` builds providers from config and wires `SyncManager`
- `sync_status` MCP tool returns provider list, primary provider, event count,
  and journal path
- End-to-end test: state transitions fire webhook calls
- Config example updated with sync section
**Status:** Done

#### Task 1.4.1: Provider factory and server wiring

- [x] Done

**Context:** `createServer()` at `src/server.ts:40-55` constructs managers and registers tools. Currently it creates `StateManager(projectRoot)` at line 42. After Epic 1.1, `StateManager` accepts an optional `SyncManager`. The factory needs to: (1) read config.sync, (2) build provider instances, (3) create SyncManager, (4) pass it to StateManager.

**Implementation vision:**

1. Create `src/sync/factory.ts` with `createProviders(syncConfig: SyncConfig): SyncProvider[]`. Iterates `Object.entries(syncConfig.providers)`, switches on each provider's `type` field: `"webhook"` → `createWebhookProvider({ name: key, ...providerConfig })`. Unknown type → log warning to stderr, skip. This is the extension point for Phase 2 providers — adding Jira means one new case.

2. In `createServer()`, after `loadConfig()`: if `config.sync.enabled`, call `createProviders(config.sync)` and construct `SyncManager(projectRoot, providers, config.sync.primary)`. Pass it to `StateManager`. If sync is disabled, pass `undefined` — backward-compatible path.

3. Add `syncManager?: SyncManager` to `ServerContext` (optional, undefined when sync disabled).

4. Register a new tool module: `registerSyncTools(server, syncManager)`.

**Files:**
- Create: `src/sync/factory.ts`
- Modify: `src/server.ts:40-55` (createServer)
- Modify: `src/tools/index.ts` (export registerSyncTools)
- Test: `src/sync/factory.test.ts`

**Verification:** `npm test -- --run src/sync/factory.test.ts` passes. `npm run build` compiles clean.

**Done when:** Server loads providers from merged config, wires them into the state machine.

---

#### Task 1.4.2: sync_status MCP tool

- [x] Done

**Context:** Tool registration follows the pattern in `src/tools/cycle.ts`, `src/tools/gate.ts`, etc. Each module exports a `register*Tools(server, ...)` function that calls `server.tool(name, schema, handler)`. The handler returns `CallToolResult` with text content.

**Implementation vision:** Create `src/tools/sync.ts`:

- `registerSyncTools(server: McpServer, syncManager?: SyncManager)`: registers `sync_status` tool.
- `sync_status` tool (no parameters): returns a formatted text response with:
  - Sync enabled/disabled
  - Provider list with names and types
  - Primary provider name (if set)
  - Total event count from journal
  - Journal file path
  - If sync is disabled: a one-line message saying so
- If `syncManager` is `undefined` (sync disabled), the tool still registers but returns "Sync is not enabled. Configure sync in .rigor/config.yaml."

**Files:**
- Create: `src/tools/sync.ts`
- Test: `src/tools/sync.test.ts`

**Verification:** `npm test -- --run src/tools/sync.test.ts` passes.

**Done when:** `sync_status` tool returns accurate sync state information.

---

#### Task 1.4.3: Update config example and end-to-end test

- [x] Done

**Context:** `skills/config.example.yaml` at line 1-128 is the annotated reference config. It needs a new `sync:` section showing users how to configure providers. The end-to-end test should prove the full path: config → provider instantiation → state transition → event dispatch → webhook call.

**Implementation vision:**

1. Append a `sync:` section to `skills/config.example.yaml` after the `gates:` block. Show the named-map provider format with both a webhook example and a commented-out Jira example. Include comments explaining the cascade, `primary`, and `events` filter.

2. Write `src/sync/e2e.test.ts` that:
   - Creates a temporary project directory with a `.rigor/config.yaml` enabling sync with a webhook provider pointed at a local HTTP server (use Node's `http.createServer` in the test)
   - Calls `createServer(tmpDir)` to get a fully wired server
   - Exercises state transitions via the state manager directly
   - Asserts the local HTTP server received events in order: `cycle_initialized`, `task_started`, `task_completed`
   - Asserts `.rigor/sync/events.jsonl` contains the matching lines

**Files:**
- Modify: `skills/config.example.yaml`
- Create: `src/sync/e2e.test.ts`

**Verification:** `npm test -- --run src/sync/e2e.test.ts` passes end-to-end.

**Done when:** Config example documents the sync feature; e2e test proves the full event pipeline from transition to HTTP delivery.

---

## Phase 2: Platform Providers + Provider SDK

### Epic 2.1: Provider SDK and Base Class

**Goal:** A `BaseProvider` abstract class exists that handles common concerns
(retry, timeout, error formatting, env-var interpolation for auth) so that
writing a new provider requires only implementing the platform-specific API
call and entity/status mapping.
**Scope:** `src/sync/providers/`
**Dependencies:** Phase 1
**Done when:** `BaseProvider` handles retry (configurable), env-var
interpolation, structured error reporting; `WebhookProvider` is refactored to
extend it; writing a new provider requires ~50 lines of platform-specific
code. Each provider declares its entity mapping and status mapping as
overridable defaults.
**Status:** Done

### Epic 2.2: Jira Cloud Provider

**Goal:** A `JiraProvider` syncs Rigor lifecycle events to Jira Cloud via
REST API v3, with configurable entity mapping (cycle→epic, epic→story,
task→subtask) and status mapping.
**Scope:** `src/sync/providers/jira.ts`
**Dependencies:** Epic 2.1 (BaseProvider)
**Done when:** Cycle init creates Jira issues matching the configured mapping;
transitions update issue status via configurable `status_map`; auth via
email + API token from global config or env vars; entity and status mappings
have sensible defaults but are overridable per-project.
**Status:** Done

### Epic 2.3: GitHub Projects Provider

**Goal:** A `GitHubProjectsProvider` syncs to GitHub Projects v2 via GraphQL,
mapping Rigor entities to project items with custom status fields.
**Scope:** `src/sync/providers/github-projects.ts`
**Dependencies:** Epic 2.1 (BaseProvider)
**Done when:** Cycle init creates project items; transitions update status
field; linked to repository; auth via GitHub token; entity mapping defaults
to cycle→project, epic→issue, task→task-list-item.
**Status:** Done

---

## Phase 3: Sync Tooling and Resilience

### Epic 3.1: Sync Retry and Replay MCP Tools

**Goal:** MCP tools let agents retry failed syncs and replay historical
events to a provider (useful for bootstrapping a new provider against an
existing cycle).
**Scope:** `src/tools/sync.ts`, `src/sync/manager.ts`
**Dependencies:** Phase 2
**Done when:** `sync_retry` retries the last N failed events for a named
provider; `sync_replay` replays all journal events to a specific provider;
both tools report per-event success/failure.
**Status:** Done

### Epic 3.2: Provider Health Monitoring

**Goal:** `SyncManager` tracks per-provider success/failure rates and exposes
them via `sync_status`. Providers that fail repeatedly are automatically
disabled with a warning, and can be re-enabled via a `sync_enable` tool.
**Scope:** `src/sync/manager.ts`, `src/tools/sync.ts`
**Dependencies:** Epic 3.1
**Done when:** Circuit-breaker pattern disables a provider after N consecutive
failures; `sync_status` shows per-provider health; `sync_enable` re-enables
a disabled provider.
**Status:** Done
