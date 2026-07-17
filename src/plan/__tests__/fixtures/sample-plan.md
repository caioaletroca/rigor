# Sample Feature Implementation Plan

> **For implementers:** This is a rolling-wave plan. Phase 1 tasks are
> dispatch-ready. Later phases are epic-level only -- elaborate them against
> the real codebase when execution reaches them.

**Goal:** Build a sample feature to validate the plan parser

**Architecture:** Simple layered architecture with handler, service, and repository. Uses dependency injection for testability.

**Tech Stack:** TypeScript, Node.js 20+, vitest

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | Core service works end-to-end with tests | 1.1, 1.2 | Detailed |
| 2 | Production hardening and monitoring | 2.1 | Epic-level |

---

## Phase 1: Core Implementation

### Epic 1.1: User service

**Goal:** `GET /users/:id` returns a persisted user end-to-end
**Scope:** `src/service/`, `src/handler/`
**Dependencies:** none
**Done when:** integration test fetches a seeded user by ID; unknown ID returns 404
**Status:** Pending

#### Task 1.1.1: Implement GetUserByID service method

- [x] Done

**Context:** `UserRepository` interface already exposes `getById` at `src/domain/repository.ts:15`. The service layer has no read path yet.

**Implementation vision:** Add `getById(id)` to `UserService`, delegating to the repository. Follow the error-handling pattern used by `create`.

**Files:**
- Modify: `src/service/user-service.ts`
- Test: `src/service/user-service.test.ts`

**Verification:** `npm test -- --grep "get by id"` passes both found and not-found cases

**Done when:** service returns the user for a known ID and a NotFoundError for an unknown one

---

#### Task 1.1.2: Add GET /users/:id handler

- [ ] Done

**Context:** Express router at `src/handler/routes.ts:8` has only POST /users. Need to add the GET route.

**Implementation vision:** Add GET route that calls UserService.getById, maps NotFoundError to 404 JSON response.

**Files:**
- Modify: `src/handler/routes.ts`
- Test: `src/handler/routes.test.ts`

**Verification:** `npm test -- --grep "GET /users"` passes

**Done when:** GET /users/:id returns 200 with user JSON or 404 with error JSON

---

### Epic 1.2: Config loader

**Goal:** Application reads configuration from a YAML file with typed defaults
**Scope:** `src/config/`
**Dependencies:** Epic 1.1
**Done when:** config loader returns typed defaults when no file exists; merges overrides when it does
**Status:** Doing

#### Task 1.2.1: Implement config reader

- [ ] Done

**Context:** No config infrastructure exists yet. The app currently uses hardcoded values in `src/constants.ts:3-12`.

**Implementation vision:** Create a YAML-based config loader that reads from `.config.yaml` and deep-merges with defaults.

**Files:**
- Create: `src/config/loader.ts`
- Test: `src/config/loader.test.ts`

**Verification:** `npm test -- --grep "config"` passes all cases

**Done when:** Config loader reads YAML, merges with defaults, handles missing file gracefully

---

## Phase 2: Production Hardening

### Epic 2.1: Observability and monitoring

**Goal:** Application has structured logging and health checks
**Scope:** `src/observability/`, `src/health/`
**Dependencies:** Phase 1
**Done when:** structured JSON logs on all requests; `/healthz` endpoint returns 200 with dependency status
**Status:** Pending
