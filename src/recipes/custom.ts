import { envPath, readEnvFile } from "../env/index.js";
import { isRef } from "../vault/index.js";
import {
  alreadyConnected,
  detectFromState,
  envSpecs,
  failed,
  inferMode,
  persist,
  refFor,
  repairEnv,
} from "./common.js";
import type { ConnectResult, EnvVarSpec, Recipe, RecipeContext, VerifyResult } from "./types.js";

const NAME = /^[A-Z_][A-Z0-9_]*$/;

function validate(value: string): string | null {
  if (!value) return "Nothing was pasted.";
  if (/[\r\n]/.test(value)) return "Paste a single line.";
  return null;
}

/**
 * Secrets for services Keysmith has no recipe for. Any env var name works; the value is
 * pasted into the hidden dialog (or moved from .env) and can't be verified.
 */
export const custom: Recipe = {
  id: "custom",
  displayName: "Other secrets",
  support: "custom",
  envVars: [],
  hosts: [],
  tiers: ["capture"],
  humanSteps: ["Paste each value into a hidden macOS dialog."],
  modeLabel: "stored, not verified",
  rotation: "Not supported: replace the value with `keysmith add <VAR> --force`.",

  envVarsFor(ctx: RecipeContext): EnvVarSpec[] {
    const names = new Set(
      ctx.vault.list({ project: ctx.project.name, service: "custom" }).map((m) => m.envVar),
    );
    for (const v of ctx.options.vars ?? []) names.add(v);
    return [...names].sort().map((name) => ({ name, secret: true, description: name }));
  },

  async detect(ctx) {
    return detectFromState(ctx, this);
  },

  async connect(ctx): Promise<ConnectResult> {
    const names = ctx.options.vars ?? [];
    const bad = names.filter((n) => !NAME.test(n));
    if (!names.length) return failed(this, "Name the env vars to store, e.g. FOO_API_KEY.");
    if (bad.length) return failed(this, `Not valid env var names: ${bad.join(", ")}.`);
    const status = await this.detect(ctx);
    const specs = envSpecs(this, ctx);
    const todo = names.filter((n) => ctx.options.force || !ctx.vault.has(refFor(ctx, this, n)));
    if (!todo.length) {
      const repaired = repairEnv(ctx, this, status);
      return repaired ?? alreadyConnected(this, status, specs);
    }

    const env = readEnvFile(envPath(ctx.project.root));
    const items = [];
    const adopted: string[] = [];
    for (const name of todo) {
      const existing = env.get(name);
      let value: string;
      if (existing && !isRef(existing) && !ctx.options.force) {
        value = existing;
        adopted.push(name);
      } else {
        const r = await ctx.capture.capture({
          title: "Keysmith",
          message: `Paste the value for ${name}. It goes straight to your macOS Keychain.`,
          url: ctx.options.url,
          validate,
        });
        if (!r.ok) return failed(this, r.message);
        value = r.value;
      }
      const tier = adopted.includes(name) ? ("imported" as const) : ("capture" as const);
      items.push({ envVar: name, value, meta: { mode: inferMode(value), tier, expires: null } });
    }
    const envVars = persist(ctx, this, items);
    return {
      service: this.id,
      outcome: "connected",
      message: `Stored ${envVars.join(", ")} in the Keychain.${adopted.length ? ` Moved ${adopted.join(", ")} from .env.` : ""} Keysmith can't verify keys for unknown services.`,
      tier: "capture",
      envVars,
    };
  },

  async verify(ctx): Promise<VerifyResult> {
    const names = envSpecs(this, ctx).map((s) => s.name);
    const missing = names.filter((n) => !ctx.vault.has(refFor(ctx, this, n)));
    if (!names.length) return { service: this.id, ok: false, message: "No custom secrets stored." };
    if (missing.length)
      return { service: this.id, ok: false, message: `Missing ${missing.join(", ")}.` };
    return {
      service: this.id,
      ok: true,
      unverified: true,
      message: `${names.join(", ")} stored (Keysmith can't check unknown services).`,
    };
  },

  auth() {
    return null;
  },
};
