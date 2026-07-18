/**
 * Scaffold module — generates new domain packs and lang packs.
 */

export {
  scaffoldLangPack,
  registerLangPackInDomain,
} from "./lang-pack.js";

export type {
  LangPackInput,
  ScaffoldResult,
} from "./lang-pack.js";

export {
  scaffoldDomainPack,
} from "./domain-pack.js";

export type {
  DomainPackInput,
  DomainCheckInput,
} from "./domain-pack.js";

export {
  discoverLangPacks,
  discoverDomainPacks,
  validateLangPackVariables,
} from "./discovery.js";

export type {
  DiscoveredPack,
  VariableValidation,
} from "./discovery.js";
