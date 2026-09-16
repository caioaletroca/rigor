export { DEFAULTS } from "./schema.js";
export type {
  RigorConfig,
  CommitConfig,
  ShipConfig,
  Gate0Config,
  Gate1Config,
  Gate8Config,
  Gate9Config,
  GatesConfig,
  CustomGatePosition,
  CustomGateConfig,
  Check,
  Metric,
  SyncConfig,
  SyncProviderConfig,
  WorkspaceConfig,
} from "./schema.js";
export {
  loadConfig,
  loadDomainPackDefaults,
  resolveVariables,
  getGlobalConfigPath,
  getGate0CheckProvenance,
} from "./loader.js";
export type { Gate0CheckProvenance, Gate0CheckSourceCategory } from "./loader.js";
