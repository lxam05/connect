import { Redactor } from "../redact.js";
import { envPath, readEnvFile, writeProjectEnv } from "../env/index.js";
import type { NewSecretMeta, SecretMeta } from "../vault/index.js";
import type { ConnectResult, Recipe, RecipeContext, Status } from "./types.js";

export const EXPIRY_WARNING_DAYS = 14;

export function refFor(ctx: RecipeContext, recipe: Recipe, envVar: string): string {
  return ctx.vault.ref(ctx.project.name, recipe.id, envVar);
}

/** Look at the vault and .env and report whether a recipe is fully set up. No network. */
export function detectFromState(ctx: RecipeContext, recipe: Recipe): Status {
  const env = readEnvFile(envPath(ctx.project.root));
  const missing: string[] = [];
  let primary: SecretMeta | undefined;
  for (const spec of recipe.envVars) {
    if (spec.secret) {
      const ref = refFor(ctx, recipe, spec.name);
      if (!ctx.vault.has(ref)) {
        missing.push(spec.name);
        continue;
      }
      primary ??= spec.vaultOnly ? undefined : ctx.vault.meta(ref);
      if (!spec.vaultOnly && env.get(spec.name) !== ref) missing.push(spec.name);
    } else if (!env.get(spec.name)) {
      missing.push(spec.name);
    }
  }
  const base = { service: recipe.id, displayName: recipe.displayName };
  const anyStored = recipe.envVars.some(
    (s) => s.secret && ctx.vault.has(refFor(ctx, recipe, s.name)),
  );
  if (!anyStored) return { ...base, state: "not_connected", missing };

  const expires = primary?.expires ?? null;
  const now = ctx.now().getTime();
  const expTime = expires ? Date.parse(expires) : NaN;
  const status: Status = {
    ...base,
    state: missing.length ? "incomplete" : "connected",
    mode: primary?.mode,
    tier: primary?.tier,
    account: primary?.account,
    expires,
    missing: missing.length ? missing : undefined,
  };
  if (!Number.isNaN(expTime)) {
    if (expTime <= now) status.state = "expired";
    else if (expTime - now < EXPIRY_WARNING_DAYS * 86_400_000) status.expiringSoon = true;
  }
  return status;
}

export interface PersistItem {
  envVar: string;
  value: string;
  meta?: NewSecretMeta;
}

/**
 * Store secrets in the vault and write placeholders/public values to .env.
 * Items whose spec is secret need `meta`.
 */
export function persist(ctx: RecipeContext, recipe: Recipe, items: PersistItem[]): string[] {
  const envEntries: { key: string; value: string; secret: boolean }[] = [];
  for (const item of items) {
    const spec = recipe.envVars.find((s) => s.name === item.envVar);
    if (!spec) throw new Error(`${recipe.id}: unknown env var ${item.envVar}`);
    if (spec.secret) {
      if (!item.meta) throw new Error(`${recipe.id}: missing metadata for ${item.envVar}`);
      const ref = refFor(ctx, recipe, spec.name);
      ctx.vault.set(ref, item.value, { ...item.meta, vaultOnly: spec.vaultOnly });
      if (!spec.vaultOnly) envEntries.push({ key: spec.name, value: ref, secret: true });
    } else {
      envEntries.push({ key: spec.name, value: item.value, secret: false });
    }
  }
  writeProjectEnv(ctx.project.root, envEntries, `# ${recipe.displayName} (managed by keysmith)`);
  return envEntries.map((e) => e.key);
}

/**
 * If the vault already holds everything but .env lost its placeholders, rewrite them.
 * Public values can't be recovered from the vault, so this only repairs secret lines.
 */
export function repairEnv(
  ctx: RecipeContext,
  recipe: Recipe,
  status: Status,
): ConnectResult | null {
  if (status.state !== "incomplete" || !status.missing) return null;
  const fixable = status.missing.every((name) => {
    const spec = recipe.envVars.find((s) => s.name === name);
    return spec?.secret && ctx.vault.has(refFor(ctx, recipe, name));
  });
  if (!fixable) return null;
  const entries = status.missing.map((name) => ({
    key: name,
    value: refFor(ctx, recipe, name),
    secret: true,
  }));
  writeProjectEnv(ctx.project.root, entries, `# ${recipe.displayName} (managed by keysmith)`);
  return {
    service: recipe.id,
    outcome: "repaired",
    message: `Restored missing placeholders in .env: ${status.missing.join(", ")}. No keys changed.`,
    envVars: status.missing,
    mode: status.mode,
  };
}

export function alreadyConnected(recipe: Recipe, status: Status): ConnectResult {
  const parts = [`${recipe.displayName} is already connected (${status.mode ?? "test"} mode).`];
  if (status.account) parts.push(`Account ${status.account}.`);
  if (status.expiringSoon && status.expires)
    parts.push(`Key expires ${status.expires.slice(0, 10)}.`);
  return {
    service: recipe.id,
    outcome: "already_connected",
    message: parts.join(" "),
    mode: status.mode,
    account: status.account,
    expires: status.expires,
    envVars: recipe.envVars.filter((s) => !s.vaultOnly).map((s) => s.name),
  };
}

export function failed(recipe: Recipe, message: string, humanSteps?: string[]): ConnectResult {
  return { service: recipe.id, outcome: "failed", message, humanSteps };
}

/** Short, value-free description of an HTTP error body. */
export async function describeHttpError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: { message?: string; code?: string };
      message?: string;
      name?: string;
    };
    const msg = body.error?.message ?? body.message ?? body.name ?? "";
    return new Redactor().redact(`HTTP ${res.status}${msg ? `: ${msg}` : ""}`);
  } catch {
    return `HTTP ${res.status}`;
  }
}
