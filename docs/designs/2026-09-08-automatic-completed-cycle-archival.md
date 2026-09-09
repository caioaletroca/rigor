# Automatic Completed-Cycle Archival -- Design Document

> **Status:** Approved
> **Date:** 2026-09-08
> **Exploration:** 3 alternatives evaluated

## Context

Completed Rigor cycles currently retain active `.rigor/state.json` and gate evidence, preventing `cycle_init` from starting another cycle. The README describes `.rigor/history/` as the location for completed cycles, but final phase advancement does not currently archive artifacts.

## Architecture

When `phase_advance` completes the final phase, it snapshots the active cycle state and evidence to a unique directory under `.rigor/history/`. It validates the snapshot before removing active runtime artifacts. A failed archive operation leaves the active state and evidence intact for diagnosis and retry.

## Components

| Component | Type | Purpose |
|---|---|---|
| Archive manager | New | Creates, validates, and cleans completed-cycle snapshots. |
| Final phase advancement | Modify | Archives a cycle only after its final phase reaches `done`. |
| State/evidence tests | Modify | Verify archival success and failure safety. |

## Data Flow

1. The client calls `phase_advance` after every epic in the final phase is accepted.
2. The state machine marks the final phase `done`.
3. The archive manager writes a state snapshot and copies all active evidence into `.rigor/history/<cycle-id>/`.
4. The archive manager validates the copied state and evidence.
5. On successful validation, active `state.json` and evidence are removed.
6. The tool returns the archive path; a subsequent `cycle_init` can create a new active cycle.
7. If copying or validation fails, active artifacts remain unchanged and the tool returns actionable recovery guidance.

## Key Decisions

| Decision | Chosen | Rejected Alternative | Why |
|---|---|---|---|
| Archive strategy | Copy, validate, then clean active artifacts | Direct move | A failed copy must not destroy the only active record. |
| Archive name | Cycle ID plus completion timestamp | Cycle ID only | Prevents collisions for repeated plans or identifiers. |
| Evidence retention | Preserve all evidence | State-only archive | Completed cycles need auditable gate results. |
| Sync journal | Remains active/shared | Copy into every archive | The journal has its own lifecycle and is not cycle-local evidence. |
| Trigger | Automatic final `phase_advance` | Explicit archive command | Completion is deterministic and should immediately unblock the next cycle. |

## Open Questions

- Define the exact archive validation contract for unknown or temporary evidence entries.
- Decide whether archive write failures should keep the final phase marked `done` in active state or roll it back before returning an error.

## Alternatives Considered

- **Atomic directory archive:** Move active state and evidence directly into history. This minimizes duplication but is less safe if a cross-directory move fails partway through.
- **State-only archive:** Archive state and delete evidence. This is simple but loses audit artifacts and contradicts the documented history purpose.
