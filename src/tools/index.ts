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
