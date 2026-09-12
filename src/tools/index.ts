/**
 * Tool registrations for the Rigor MCP gate server.
 */

export { registerCycleTools } from "./cycle.js";
export type { CycleInitParams } from "./cycle.js";
export { ProjectContextRegistry, resolveProjectRoot } from "../context.js";
export type { ProjectRootResolution, RequestContext } from "../context.js";
export { handleCycleInit, handleCycleStatus } from "./cycle.js";

export { projectRootSchema, resolveRequestContext, responseResult } from "./lifecycle.js";

export { registerGateTools } from "./gate.js";
export type { TaskStartParams, TaskCompleteParams, TaskRenewParams } from "../services/task-lifecycle.js";
export { handleTaskStart, handleTaskComplete, handleTaskRenew } from "../services/task-lifecycle.js";

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

export { registerScaffoldTools, handleNewLangPack, handleNewDomain, handleInstallCommands } from "./scaffold.js";
export type { NewLangPackParams, NewDomainParams, InstallCommandsParams } from "./scaffold.js";
