/**
 * Sync module barrel export.
 */

export { SyncManager } from "./manager.js";
export type { ProviderHealth } from "./manager.js";
export {
  shouldDispatch,
  transitionToEventType,
} from "./schema.js";
export type {
  SyncEvent,
  SyncEventType,
  SyncEntityType,
  SyncProvider,
  SyncResult,
} from "./schema.js";
