export { checkGate0Exit } from "./gate0.js";
export type { Gate0Result } from "./gate0.js";

export { checkGate1Exit, detectDependencyChanges, saveBaseline } from "./gate1.js";
export type { Gate1Result } from "./gate1.js";

export { checkGate8Exit } from "./gate8.js";
export type {
  Gate8Result,
  ReviewFindings,
  ReviewFinding,
} from "./gate8.js";

export { checkGate9Exit } from "./gate9.js";
export type {
  Gate9Result,
  AcceptanceCriterion,
} from "./gate9.js";

export { runCustomGates } from "./custom.js";
export type { CustomGateResult } from "./custom.js";
