/**
 * Tool registrations for the Rigor MCP gate server.
 */

export { registerCycleTools } from "./cycle.js";
export type { CycleInitParams } from "./cycle.js";
export { handleCycleInit, handleCycleStatus } from "./cycle.js";

export { registerGateTools } from "./gate.js";
export type { TaskStartParams, TaskCompleteParams } from "./gate.js";
export { handleTaskStart, handleTaskComplete } from "./gate.js";

export { registerReviewTools } from "./review.js";
export type {
  ReviewStartParams,
  ReviewSubmitParams,
  AcceptStartParams,
  AcceptSubmitParams,
} from "./review.js";
export {
  handleReviewStart,
  handleReviewSubmit,
  handleAcceptStart,
  handleAcceptSubmit,
  handlePhaseAdvance,
} from "./review.js";

export { registerRecoveryTools } from "./recovery.js";
export type {
  CycleResetParams,
  TaskRetryParams,
  TaskManageParams,
  EpicManageParams,
  PhaseManageParams,
} from "./recovery.js";
export {
  handleCycleReset,
  handleTaskRetry,
  handleTaskManage,
  handleEpicManage,
  handlePhaseManage,
  handleCycleDiagnose,
} from "./recovery.js";

export { registerSyncTools, handleSyncStatus, handleSyncRetry, handleSyncReplay, handleSyncEnable } from "./sync.js";
export type { SyncRetryParams, SyncReplayParams, SyncEnableParams } from "./sync.js";
