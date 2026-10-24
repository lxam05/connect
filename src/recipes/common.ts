import { Redactor } from "../redact.js";
import { envPath, readEnvFile, writeProjectEnv } from "../env/index.js";
import type { Mode, NewSecretMeta, SecretMeta } from "../vault/index.js";
import type { ConnectResult, EnvVarSpec, Recipe, RecipeContext, Status } from "./types.js";

export const EXPIRY_WARNING_DAYS = 14;

export function refFor(ctx: RecipeContext, recipe: Recipe, envVar: string): string {
  return ctx.vault.ref(ctx.project.name, recipe.id, envVar);
}

/** The env vars a recipe manages in this project. */
export function envSpecs(recipe: Recipe, ctx: RecipeContext): EnvVarSpec[] {
  return recipe.envVarsFor?.(ctx) ?? recipe.envVars;
}

/** Live or test, from a key's prefix. Unknown shapes count as test. */
export function inferMode(value: string): Mode {
  return /(^|_)live_/.test(value) ? "live" : "test";
}

/** "test mode", or the recipe's own label (e.g. "sending access"). */
export function describeMode(recipe: Pick<Recipe, "modeLabel">, mode?: Mode): string {
  return recipe.modeLabel ?? `${mode ?? "test"} mode`;
}

/** Look at the vault and .env and report whether a recipe is fully set up. No network. */
export function detectFromState(ctx: RecipeContext, recipe: Recipe): Status {
  const env = readEnvFile(envPath(ctx.project.root));
  const missing: string[] = [];
  let primary: SecretMeta | undefined;
  const specs = envSpecs(recipe, ctx);
  for (const spec of specs) {
    if (spec.secret) {
      const ref = refFor(ctx, recipe, spec.name);
      if (!ctx.vault.has(ref)) {
        // Vault-only keys (e.g. an admin key for rotation) are optional for a working app.
        if (!spec.vaultOnly) missing.push(spec.name);
        continue;
      }
      primary ??= spec.vaultOnly ? undefined : ctx.vault.meta(ref);
      if (!spec.vaultOnly && env.get(spec.name) !== ref) missing.push(spec.name);
    } else if (!env.get(spec.name)) {
      missing.push(spec.name);
    }
  }
  const base = { service: recipe.id, displayName: recipe.displayName };
  const anyStored = specs.some((s) => s.secret && ctx.vault.has(refFor(ctx, recipe, s.name)));
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
    accountName: primary?.accountName,
    modeLabel: recipe.modeLabel,
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
    const spec = envSpecs(recipe, ctx).find((s) => s.name === item.envVar);
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
    const spec = envSpecs(recipe, ctx).find((s) => s.name === name);
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

/**
 * Ask the user to pick a provider project or account. The wording depends on who reads it:
 * the CLI user runs a command, an agent asks the user and calls connect again.
 */
export function chooseProject(
  ctx: RecipeContext,
  recipe: Recipe,
  kind: string,
  choices: { id: string; name: string; note?: string }[],
): ConnectResult {
  const list = choices
    .map((c) => `${accountLabel(c.id, c.name)}${c.note ? ` [${c.note}]` : ""}`)
    .join(", ");
  const message = ctx.options.wait
    ? `Several ${recipe.displayName} ${kind}s are available: ${list}. Pick one with \`keysmith connect ${recipe.id} --project <id>\` (or \`keysmith setup --project <id>\`).`
    : `Several ${recipe.displayName} ${kind}s are available. Ask the user which one, then call connect("${recipe.id}") again with project set to its id. Choices: ${list}.`;
  return {
    service: recipe.id,
    outcome: "action_required",
    message,
    humanSteps: [
      `Choose a ${recipe.displayName} ${kind}: ${choices.map((c) => c.name).join(", ")}`,
    ],
  };
}

/** `"Gap Detector sandbox" (acct_123)`, or just the id when there's no name. */
export function accountLabel(id: string, name?: string): string {
  return name ? `"${name}" (${id})` : id;
}

export function alreadyConnected(
  recipe: Recipe,
  status: Status,
  specs: EnvVarSpec[] = recipe.envVars,
): ConnectResult {
  const parts = [
    `${recipe.displayName} is already connected (${describeMode(recipe, status.mode)}).`,
  ];
  if (status.account) parts.push(`Account ${accountLabel(status.account, status.accountName)}.`);
  if (status.expiringSoon && status.expires)
    parts.push(`Key expires ${status.expires.slice(0, 10)}.`);
  return {
    service: recipe.id,
    outcome: "already_connected",
    message: parts.join(" "),
    mode: status.mode,
    account: status.account,
    accountName: status.accountName,
    expires: status.expires,
    envVars: specs.filter((s) => !s.vaultOnly).map((s) => s.name),
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
