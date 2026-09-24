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
export { registerReadinessTool, handleProjectReadiness } from "./readiness.js";
export type { ProjectReadinessParams } from "./readiness.js";
export type { TaskStartParams, TaskCompleteParams } from "../services/task-lifecycle.js";
export { handleTaskStart, handleTaskComplete } from "../services/task-lifecycle.js";

export { registerReviewTools } from "./review.js";
export type {
  ReviewStartParams,
  ReviewSubmitParams,
  AcceptStartParams,
  AcceptSubmitParams,
} from "../services/review-lifecycle.js";
export {
  handleReviewStart,
  handleReviewSubmit,
  handleAcceptStart,
  handleAcceptSubmit,
  handlePhaseAdvance,
} from "../services/review-lifecycle.js";

export { registerRecoveryTools } from "./recovery.js";
export type {
  CycleResetParams,
  TaskRetryParams,
  TaskManageParams,
  EpicManageParams,
  PhaseManageParams,
} from "../services/recovery-lifecycle.js";
export {
  handleCycleReset,
  handleTaskRetry,
  handleTaskManage,
  handleEpicManage,
  handlePhaseManage,
  handleCycleDiagnose,
} from "../services/recovery-lifecycle.js";

export { registerSyncTools, handleSyncStatus, handleSyncRetry, handleSyncReplay, handleSyncEnable } from "./sync.js";
export type { SyncRetryParams, SyncReplayParams, SyncEnableParams } from "./sync.js";

export { registerScaffoldTools, handleNewLangPack, handleNewDomain, handleInstallCommands } from "./scaffold.js";
export type { NewLangPackParams, NewDomainParams, InstallCommandsParams } from "./scaffold.js";

export {
  REGISTERED_TOOL_NAMES,
  RIGOR_SCHEMA_VERSION,
  RIGOR_SERVER_NAME,
  RIGOR_SERVER_VERSION,
  ROOT_AWARE_LIFECYCLE_TOOLS,
  handleServerInfo,
  registerServerInfoTool,
} from "./server-info.js";
export type { ServerInfoParams } from "./server-info.js";
