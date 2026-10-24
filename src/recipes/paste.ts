import { prefixValidator } from "../capture/index.js";
import { envPath, readEnvFile } from "../env/index.js";
import { isRef } from "../vault/index.js";
import { type CatalogEntry, type CatalogVar, type VerifiedEntry, isVerified } from "./catalog.js";
import {
  accountLabel,
  alreadyConnected,
  chooseProject,
  describeHttpError,
  detectFromState,
  failed,
  persist,
  refFor,
  repairEnv,
} from "./common.js";
import type { Mode } from "../vault/index.js";
import type { ConnectResult, Recipe, RecipeContext, VerifyResult } from "./types.js";

type Values = Record<string, string>;

export function validatorFor(v: CatalogVar, label: string): (value: string) => string | null {
  if (v.prefixes) return prefixValidator(v.prefixes, label);
  return (value) => {
    if (!value) return "Nothing was pasted.";
    if (/\s/.test(value)) return "The value contains spaces — paste only the key.";
    if (v.pattern && !v.pattern.test(value)) return `That doesn't look like ${label}.`;
    if (!v.pattern && value.length < 8) return "That value looks too short.";
    return null;
  };
}

function authHeaders(entry: VerifiedEntry, values: Values): Record<string, string> {
  const a = entry.auth;
  if (a.type === "bearer") return { Authorization: `Bearer ${values[a.secret]}`, ...a.extra };
  if (a.type === "header") return { [a.name]: `${a.prefix ?? ""}${values[a.secret]}`, ...a.extra };
  const basic = Buffer.from(`${values[a.user]}:${values[a.secret]}`).toString("base64");
  return { Authorization: `Basic ${basic}` };
}

async function callApi(
  ctx: RecipeContext,
  entry: VerifiedEntry,
  values: Values,
  pathTemplate: string,
): Promise<Response> {
  const path = pathTemplate.replace(/\{(\w+)\}/g, (_, name: string) =>
    encodeURIComponent(values[name] ?? ""),
  );
  return ctx.fetch(`https://${entry.host}${path}`, {
    headers: { ...authHeaders(entry, values), "User-Agent": "keysmith/0.1" },
  });
}

async function check(
  ctx: RecipeContext,
  entry: VerifiedEntry,
  values: Values,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const res = await callApi(ctx, entry, values, entry.verifyPath);
  return res.ok ? { ok: true } : { ok: false, message: await describeHttpError(res) };
}

interface Derived {
  value?: string;
  account?: { id: string; name?: string };
  /** Set when a choice is needed from the user. */
  choices?: { id: string; name: string }[];
  error?: string;
}

/** Values filled in from the API rather than asked for. Keyed by env var name. */
const DERIVERS: Record<
  string,
  (ctx: RecipeContext, entry: VerifiedEntry, values: Values) => Promise<Derived>
> = {
  async CLOUDFLARE_ACCOUNT_ID(ctx, entry, values) {
    const res = await callApi(ctx, entry, values, "/client/v4/accounts?per_page=50");
    if (!res.ok) return { error: `couldn't list accounts (${await describeHttpError(res)})` };
    const body = (await res.json()) as { result?: { id: string; name: string }[] };
    const accounts = body.result ?? [];
    const wanted = ctx.options.project;
    const pick =
      accounts.length === 1
        ? accounts[0]
        : accounts.find((a) => a.id === wanted || a.name === wanted);
    if (pick) return { value: pick.id, account: { id: pick.id, name: pick.name } };
    if (!accounts.length) return { error: "this token can't see any Cloudflare accounts" };
    return { choices: accounts.map((a) => ({ id: a.id, name: a.name })) };
  },
};

/** Build a guided-paste Recipe from a catalog entry. */
export function pasteRecipe(entry: CatalogEntry): Recipe {
  const plain = entry.envVars.filter((v) => !v.derived);
  const derived = entry.envVars.filter((v) => v.derived);
  const verified = isVerified(entry) ? entry : undefined;
  const unverifiable = isVerified(entry) ? "" : entry.unverifiable;
  const modeFor = (value: string): Mode =>
    entry.testPrefixes?.some((p) => value.startsWith(p)) ? "test" : "live";
  /** The value that decides the mode: the auth secret, or the first secret var. */
  const primary = verified?.auth.secret ?? plain.find((v) => v.secret)!.name;

  /** Values already available: secrets from the vault, public ones from .env. */
  function stored(ctx: RecipeContext, recipe: Recipe): Values {
    const env = readEnvFile(envPath(ctx.project.root));
    const values: Values = {};
    for (const v of entry.envVars) {
      const value = v.secret ? ctx.vault.resolve(refFor(ctx, recipe, v.name)) : env.get(v.name);
      if (value && !(v.secret === false && isRef(value))) values[v.name] = value;
    }
    return values;
  }

  return {
    id: entry.id,
    displayName: entry.displayName,
    support: verified ? "verified-paste" : "catalog-only",
    envVars: entry.envVars.map((v) => ({
      name: v.name,
      secret: v.secret,
      description: v.description,
    })),
    hosts: verified ? [verified.host] : [],
    tiers: ["capture"],
    humanSteps: [
      `Copy ${plain.map((v) => v.name).join(" and ")} from ${entry.keyPage} into a hidden macOS dialog.`,
    ],
    blockedPaths: verified?.blockedPaths,
    signals: { packages: entry.packages },
    modeLabel: verified ? undefined : "stored, not verified",
    modeFor,
    rotation: `Not automatic: roll the key at ${entry.keyPage}, then run \`keysmith connect ${entry.id}\` again after removing the old one.`,

    async detect(ctx) {
      return detectFromState(ctx, this);
    },

    async connect(ctx): Promise<ConnectResult> {
      const status = await this.detect(ctx);
      if (status.state === "connected" && !ctx.options.force) return alreadyConnected(this, status);
      const repaired = repairEnv(ctx, this, status);
      if (repaired) return repaired;

      const env = readEnvFile(envPath(ctx.project.root));
      const have = ctx.options.force ? {} : stored(ctx, this);
      const values: Values = {};
      const adopted: string[] = [];
      let openedPage = false;
      for (const v of plain) {
        const label = `a ${entry.displayName} ${v.description}`;
        const validate = validatorFor(v, label);
        if (have[v.name]) {
          values[v.name] = have[v.name]!;
          continue;
        }
        // A real value already in .env: move it into the Keychain instead of asking.
        const existing = env.get(v.name);
        if (existing && !isRef(existing) && !validate(existing)) {
          values[v.name] = existing;
          if (v.secret) adopted.push(v.name);
          continue;
        }
        if (!openedPage) ctx.progress(`Opening ${entry.keyPage}. Paste ${v.name} into the dialog.`);
        const r = await ctx.capture.capture({
          title: `Keysmith — ${entry.displayName}`,
          message: `Paste your ${entry.displayName} ${v.description} (${v.name}). It goes straight to your macOS Keychain.`,
          url: openedPage ? undefined : entry.keyPage,
          validate,
        });
        openedPage = true;
        if (!r.ok) return failed(this, r.message, [`Copy ${v.name} from ${entry.keyPage}.`]);
        values[v.name] = r.value;
      }

      if (verified) {
        const ok = await check(ctx, verified, values);
        if (!ok.ok)
          return failed(
            this,
            `${entry.displayName} rejected the key (${ok.message}). Nothing was saved.`,
          );
      }

      const mode = modeFor(values[primary]!);
      const tier = adopted.includes(primary) ? "imported" : "capture";
      let account: { id: string; name?: string } | undefined;
      const derivedValues: Values = {};
      const pending: ConnectResult[] = [];
      for (const v of derived) {
        const d = await DERIVERS[v.name]!(ctx, verified!, values);
        if (d.value) {
          derivedValues[v.name] = d.value;
          account ??= d.account;
        } else if (d.choices) {
          pending.push(chooseProject(ctx, this, "account", d.choices));
        } else {
          return failed(this, `Couldn't fill in ${v.name}: ${d.error}.`);
        }
      }

      const envVars = persist(ctx, this, [
        ...plain.map((v) => ({
          envVar: v.name,
          value: values[v.name]!,
          meta: v.secret
            ? { mode, tier, expires: null, account: account?.id, accountName: account?.name }
            : undefined,
        })),
        ...Object.entries(derivedValues).map(([envVar, value]) => ({ envVar, value })),
      ]);
      if (pending.length) return { ...pending[0]!, envVars };
      const where = account ? `, account ${accountLabel(account.id, account.name)}` : "";
      const how = verified ? `${mode} mode${where}` : `not verified: ${unverifiable}`;
      return {
        service: this.id,
        outcome: "connected",
        message: `${entry.displayName} connected (${how}).${adopted.length ? ` Moved ${adopted.join(", ")} from .env into the Keychain.` : ""}`,
        tier,
        envVars,
        mode,
        account: account?.id,
        accountName: account?.name,
      };
    },

    async verify(ctx): Promise<VerifyResult> {
      const values = stored(ctx, this);
      const missing = plain.filter((v) => !values[v.name]).map((v) => v.name);
      if (missing.length)
        return {
          service: this.id,
          ok: false,
          message: `Not connected (missing ${missing.join(", ")}).`,
        };
      const mode = modeFor(values[primary]!);
      if (!verified)
        return {
          service: this.id,
          ok: true,
          unverified: true,
          message: `${plain.map((v) => v.name).join(", ")} stored, not verified: ${unverifiable}`,
          mode,
        };
      const ok = await check(ctx, verified, values);
      return ok.ok
        ? {
            service: this.id,
            ok: true,
            message: `${verified.auth.secret} works (${mode} mode).`,
            mode,
          }
        : {
            service: this.id,
            ok: false,
            message: `${entry.displayName} rejected the key (${ok.message}).`,
          };
    },

    auth(ctx) {
      if (!verified) return null;
      const values = stored(ctx, this);
      const secret = values[verified.auth.secret];
      if (!secret) return null;
      return { headers: authHeaders(verified, values), secrets: [secret], mode: modeFor(secret) };
    },
  };
}
