import { CATALOG, isVerified } from "./recipes/catalog.js";
import { recipes } from "./recipes/registry.js";
import type { Support } from "./recipes/types.js";
import type { Tier } from "./vault/index.js";

/** One service as the marketing site shows it. Public metadata only. */
export interface SiteService {
  id: string;
  displayName: string;
  support: Support;
  envVars: { name: string; secret: boolean; description: string }[];
  tiers: Tier[];
  humanSteps: string[];
  rotation?: string;
  keyPage?: string;
  docsUrl?: string;
  /** Read endpoint the key is checked against, e.g. "GET api.groq.com/openai/v1/models". */
  verifiedWith?: string;
  /** Why the key can't be checked (catalog-only services). */
  unverifiable?: string;
}

/** Every service Keysmith knows, for site/catalog.json. Built by `npm run build`. */
export function siteCatalog(): SiteService[] {
  return recipes.map((r) => {
    const entry = CATALOG.find((e) => e.id === r.id);
    const service: SiteService = {
      id: r.id,
      displayName: r.displayName,
      support: r.support,
      envVars: r.envVars
        .filter((v) => !v.vaultOnly)
        .map((v) => ({ name: v.name, secret: v.secret, description: v.description })),
      tiers: r.tiers,
      humanSteps: r.humanSteps,
      rotation: r.rotation,
    };
    if (entry) {
      service.keyPage = entry.keyPage;
      service.docsUrl = entry.docsUrl;
      if (isVerified(entry)) service.verifiedWith = `GET ${entry.host}${entry.verifyPath}`;
      else service.unverifiable = entry.unverifiable;
    }
    return service;
  });
}
