import { envPath, removeEnvKeys, upsertEnvFile } from "../env/index.js";
import { inferMode, persist, refFor } from "../recipes/common.js";
import { custom } from "../recipes/custom.js";
import { ownerOf } from "../recipes/registry.js";
import type { RecipeContext } from "../recipes/types.js";

const PUBLIC_PREFIX = /^(NEXT_PUBLIC_|PUBLIC_|VITE_|EXPO_PUBLIC_|REACT_APP_)/;
const SECRET_NAME =
  /(^|_)(KEY|SECRET|TOKEN|PASSWORD|PASS|PWD|DSN|PRIVATE_KEY)$|^DATABASE_URL$|_DATABASE_URL$/;
const SECRET_VALUE =
  /^((sk|rk)_(test|live)_|whsec_|re_[A-Za-z0-9]|sk-|SG\.|eyJ|postgres(ql)?:\/\/[^:]+:[^@]+@)/;

/** Whether an env var probably holds a secret, judged by its name and value shape. */
export function looksSecret(name: string, value = ""): boolean {
  const owner = ownerOf(name)?.envVars.find((v) => v.name === name);
  if (owner) return owner.secret;
  if (PUBLIC_PREFIX.test(name)) return false;
  return SECRET_NAME.test(name) || SECRET_VALUE.test(value);
}

export interface ImportResult {
  /** Secrets moved into the Keychain, by name. */
  imported: string[];
  /** Public values written to .env as-is. */
  public: string[];
  /** Already managed by Keysmith, left alone. */
  skipped: string[];
}

/**
 * Store values that came from outside Keysmith (.env, Vercel). Each secret goes to the
 * recipe that owns its env var (or `custom`) and is replaced by a placeholder. Returns
 * names only. `removeFrom` lists other env files the plain values should be deleted from.
 */
export function importSecrets(
  ctx: RecipeContext,
  values: Map<string, string>,
  source: string,
  removeFrom: string[] = [],
): ImportResult {
  const result: ImportResult = { imported: [], public: [], skipped: [] };
  const plainPublic: { key: string; value: string }[] = [];
  for (const [name, value] of values) {
    if (!value || value.startsWith("keysmith://")) continue;
    const owner = ownerOf(name) ?? (looksSecret(name, value) ? custom : undefined);
    const spec = owner?.envVars.find((v) => v.name === name);
    if (!owner || (spec && !spec.secret)) {
      plainPublic.push({ key: name, value });
      continue;
    }
    if (ctx.vault.has(refFor(ctx, owner, name))) {
      result.skipped.push(name);
      continue;
    }
    // `custom` only knows the vars it's told about, so name this one for the write.
    const saved = ctx.options;
    if (owner === custom) ctx.options = { ...saved, vars: [name] };
    try {
      persist(ctx, owner, [
        { envVar: name, value, meta: { mode: inferMode(value), tier: "imported", expires: null } },
      ]);
    } finally {
      ctx.options = saved;
    }
    result.imported.push(name);
  }
  if (plainPublic.length && source !== "dotenv") {
    upsertEnvFile(envPath(ctx.project.root), plainPublic, `# Imported from ${source}`);
    result.public.push(...plainPublic.map((p) => p.key));
  }
  for (const file of removeFrom) removeEnvKeys(file, result.imported);
  return result;
}
