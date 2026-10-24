import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { prefixValidator } from "../capture/index.js";
import { Redactor } from "../redact.js";
import type { BackgroundProcess } from "../sys.js";
import type { Tier } from "../vault/index.js";
import {
  accountLabel,
  alreadyConnected,
  describeHttpError,
  detectFromState,
  failed,
  persist,
  refFor,
  repairEnv,
} from "./common.js";
import type { ConnectResult, Recipe, RecipeContext, VerifyResult } from "./types.js";

const API = "https://api.stripe.com";
const KEYS_PAGE = "https://dashboard.stripe.com/test/apikeys";
const SECRET = "STRIPE_SECRET_KEY";
const PUBLISHABLE = "STRIPE_PUBLISHABLE_KEY";
const NEXT_PUBLISHABLE = "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY";
const TEST_SECRET = /^(sk|rk)_test_[A-Za-z0-9]+$/;
const TEST_PUBLISHABLE = /^pk_test_[A-Za-z0-9]+$/;
const INSTALL_CMD = "brew install stripe/stripe-cli/stripe";

interface CliKeys {
  secret?: string;
  publishable?: string;
  expires: string | null;
  account?: string;
  displayName?: string;
}

/** Field names verified against Stripe CLI 1.53 config.toml. */
function readCliConfig(ctx: RecipeContext, profile: string): CliKeys | null {
  const base = ctx.sys.env.XDG_CONFIG_HOME ?? join(ctx.sys.homedir(), ".config");
  const raw = ctx.sys.readFile(join(base, "stripe", "config.toml"));
  if (!raw) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const section = parsed[profile] as Record<string, unknown> | undefined;
  if (!section) return null;
  const str = (k: string) => (typeof section[k] === "string" ? (section[k] as string) : undefined);
  const expiresRaw = str("test_mode_key_expires_at");
  const expTime = expiresRaw ? Date.parse(expiresRaw) : NaN;
  return {
    secret: str("test_mode_api_key"),
    publishable: str("test_mode_pub_key"),
    expires: Number.isNaN(expTime) ? null : new Date(expTime).toISOString(),
    account: str("account_id"),
    displayName: str("display_name"),
  };
}

/**
 * Value-free summary of the CLI config for error messages: profiles, field names,
 * key prefixes (e.g. "rk_test_") and expiry dates. Never includes a key.
 */
export function describeCliConfig(ctx: RecipeContext): string {
  const base = ctx.sys.env.XDG_CONFIG_HOME ?? join(ctx.sys.homedir(), ".config");
  const raw = ctx.sys.readFile(join(base, "stripe", "config.toml"));
  if (!raw) return "no ~/.config/stripe/config.toml";
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(raw) as Record<string, unknown>;
  } catch {
    return "config.toml could not be parsed";
  }
  const describe = (k: string, v: unknown): string => {
    if (typeof v !== "string") return typeof v;
    if (/expires/.test(k)) return v;
    const prefix = /^([a-z]+_(?:test|live)_)/.exec(v)?.[1];
    return prefix ? `${prefix}…` : "set";
  };
  return Object.entries(parsed)
    .filter(([, v]) => v && typeof v === "object")
    .map(
      ([name, v]) =>
        `[${name}] ` +
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => /key|expires|account/.test(k))
          .map(([k, x]) => `${k}=${describe(k, x)}`)
          .join(", "),
    )
    .join("; ");
}

function profileName(ctx: RecipeContext): string {
  return ctx.sys.env.KEYSMITH_STRIPE_PROFILE ?? "default";
}

export function profileArgs(ctx: RecipeContext): string[] {
  const p = profileName(ctx);
  return p === "default" ? [] : ["--project-name", p];
}

async function stripeGet(ctx: RecipeContext, key: string, path: string): Promise<Response> {
  // Basic auth with the key as username, as documented by Stripe.
  return ctx.fetch(`${API}${path}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
      "User-Agent": "keysmith/0.1",
    },
  });
}

export interface Account {
  id: string;
  name?: string;
}

interface AccountBody {
  id?: string;
  settings?: { dashboard?: { display_name?: string | null } };
  business_profile?: { name?: string | null };
}

function parseAccount(body: AccountBody): Account | undefined {
  if (!body.id?.startsWith("acct_")) return undefined;
  const name = body.settings?.dashboard?.display_name ?? body.business_profile?.name ?? undefined;
  return { id: body.id, name: name || undefined };
}

interface KeyCheck {
  ok: boolean;
  message: string;
  account?: Account;
  canCheckout?: boolean;
}

async function checkKey(ctx: RecipeContext, key: string): Promise<KeyCheck> {
  const balance = await stripeGet(ctx, key, "/v1/balance");
  if (!balance.ok)
    return { ok: false, message: `Stripe rejected the key (${await describeHttpError(balance)}).` };
  const body = (await balance.json()) as { livemode?: boolean };
  if (body.livemode !== false) return { ok: false, message: "That key is not a test-mode key." };
  // Restricted keys may not be allowed to read the account; that's fine, the id is just unknown.
  const acct = await stripeGet(ctx, key, "/v1/account");
  const account = acct.ok ? parseAccount((await acct.json()) as AccountBody) : undefined;
  const checkout = await stripeGet(ctx, key, "/v1/checkout/sessions?limit=1");
  return { ok: true, message: "ok", account, canCheckout: checkout.ok };
}

/** The account the Stripe CLI is currently using (what `stripe listen` forwards from). */
export async function cliAccount(ctx: RecipeContext): Promise<Account | undefined> {
  if (!(await ctx.sys.which("stripe"))) return undefined;
  const r = await ctx.sys.exec("stripe", ["get", "/v1/account", ...profileArgs(ctx)], {
    timeoutMs: 20_000,
  });
  if (r.code !== 0) return undefined;
  try {
    return parseAccount(JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as AccountBody);
  } catch {
    return undefined;
  }
}

/** Warns when webhooks from `stripe listen` would come from a different account than the key. */
async function cliMismatchWarning(
  ctx: RecipeContext,
  account: Account | undefined,
): Promise<string | undefined> {
  if (!account) return undefined;
  const cli = await cliAccount(ctx);
  if (!cli || cli.id === account.id) return undefined;
  return (
    `The Stripe CLI is using ${accountLabel(cli.id, cli.name)}, but Keysmith's key belongs to ` +
    `${accountLabel(account.id, account.name)}. Events from \`stripe listen\` won't reach this app. ` +
    `Run \`stripe switch ${account.id}\` (after \`stripe login\` if needed), or reconnect with ` +
    `\`keysmith connect stripe --tier capture --force\` using a key from the CLI's account.`
  );
}

/** One in-flight `stripe login` per profile, kept alive across MCP calls. */
interface PendingLogin {
  code: string;
  browserUrl: string;
  proc: BackgroundProcess;
  result?: { code: number; stderr: string };
}
const pendingLogins = new Map<string, PendingLogin>();

interface LoginStart {
  browser_url?: string;
  verification_code?: string;
  next_step?: string;
}

/**
 * Turn the CLI's `next_step` into argv. Older CLIs return `stripe login --complete <url>`,
 * newer ones (OAuth device flow) return `stripe login --complete-device`. Only these
 * shapes are accepted so we never run an arbitrary command from CLI output.
 */
export function parseNextStep(nextStep: string): string[] | null {
  const words =
    nextStep.match(/'[^']*'|"[^"]*"|\S+/g)?.map((w) => w.replace(/^['"]|['"]$/g, "")) ?? [];
  if (words[0] !== "stripe" || words[1] !== "login") return null;
  const args = words.slice(1);
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--complete-device") continue;
    if ((a === "--complete" || a === "--project-name") && args[i + 1]) {
      if (a === "--complete" && !/^https:\/\/[a-z.]*stripe\.com\//.test(args[i + 1]!)) return null;
      i++;
      continue;
    }
    return null;
  }
  return args.some((a) => a === "--complete" || a === "--complete-device") ? args : null;
}

async function startLogin(ctx: RecipeContext): Promise<PendingLogin | string> {
  const r = await ctx.sys.exec("stripe", ["login", "--non-interactive", ...profileArgs(ctx)], {
    timeoutMs: 60_000,
  });
  let start: LoginStart;
  try {
    start = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as LoginStart;
  } catch {
    return `stripe login did not return the expected JSON (exit ${r.code}).`;
  }
  const next = parseNextStep(start.next_step ?? "");
  if (!start.browser_url || !start.verification_code || !next) {
    const shape = new Redactor().redact(
      `fields: ${Object.keys(start).join(", ") || "none"}; next_step: ${start.next_step ?? "none"}`,
    );
    return `stripe login --non-interactive returned a response Keysmith doesn't recognize (${shape}).`;
  }
  if (!next.includes("--project-name")) next.push(...profileArgs(ctx));
  const proc = ctx.sys.spawnBackground("stripe", next);
  const pending: PendingLogin = {
    code: start.verification_code,
    browserUrl: start.browser_url,
    proc,
  };
  void proc.done.then((res) => (pending.result = { code: res.code, stderr: res.stderr }));
  await ctx.sys.open(start.browser_url);
  return pending;
}

function loginAction(pending: PendingLogin): ConnectResult {
  return {
    service: "stripe",
    outcome: "action_required",
    message: `Waiting for Stripe sign-in. A browser tab is open; the user must confirm the pairing code ${pending.code} matches and click Allow. Call connect("stripe") again afterwards.`,
    tier: "cli",
    humanSteps: [
      `In the browser tab Stripe opened, check the pairing code reads ${pending.code} and click "Allow access". If no tab opened, visit ${pending.browserUrl}`,
    ],
  };
}

/**
 * Make sure the Stripe CLI holds fresh test keys. Returns them, or a ConnectResult
 * describing what the human must do next.
 */
/** The CLI is signed in but doesn't expose test keys in config.toml (newer device-flow CLIs). */
const CLI_KEYS_UNAVAILABLE = "cli-keys-unavailable" as const;

async function ensureCliLogin(
  ctx: RecipeContext,
): Promise<CliKeys | ConnectResult | typeof CLI_KEYS_UNAVAILABLE> {
  const profile = profileName(ctx);
  const fresh = (k: CliKeys | null) =>
    k?.secret && (!k.expires || Date.parse(k.expires) > ctx.now().getTime()) ? k : null;

  const pending = pendingLogins.get(profile);
  let justLoggedIn = false;
  if (pending) {
    if (!pending.result && ctx.options.wait) await pending.proc.done.then(() => undefined);
    if (!pending.result) return loginAction(pending);
    pendingLogins.delete(profile);
    if (pending.result.code !== 0) {
      return failed(
        stripe,
        "Stripe sign-in was not completed (it may have been denied or timed out). Call connect again to retry.",
      );
    }
    justLoggedIn = true;
  }

  const keys = fresh(readCliConfig(ctx, profile));
  if (keys) return keys;
  const current = readCliConfig(ctx, profile);
  if (justLoggedIn || (current?.account && !current.secret)) {
    // Signed in, but the CLI keeps its key somewhere we can't read through a documented path.
    // Don't loop into another sign-in; the caller falls back to the dashboard + secure paste.
    ctx.progress(`Stripe CLI is signed in but exposes no test key (${describeCliConfig(ctx)}).`);
    return CLI_KEYS_UNAVAILABLE;
  }

  ctx.progress("Starting Stripe CLI sign-in…");
  const started = await startLogin(ctx);
  if (typeof started === "string") return failed(stripe, started);
  pendingLogins.set(profile, started);
  if (!ctx.options.wait) return loginAction(started);

  ctx.progress(`Approve the pairing code ${started.code} in your browser…`);
  await started.proc.done;
  return ensureCliLogin(ctx);
}

async function captureKeys(
  ctx: RecipeContext,
  publishable?: string,
): Promise<CliKeys | ConnectResult> {
  ctx.progress(
    "Opening the Stripe test API keys page — paste a test secret key into the Keychain dialog.",
  );
  const secret = await ctx.capture.capture({
    title: "Keysmith — Stripe",
    message:
      "Paste a Stripe TEST secret key (sk_test_… or a restricted rk_test_… key). It goes straight to your macOS Keychain.",
    url: KEYS_PAGE,
    validate: prefixValidator(["sk_test_", "rk_test_"], "a Stripe test secret key"),
  });
  if (!secret.ok) {
    return failed(stripe, secret.message, [
      `Copy a test secret key from ${KEYS_PAGE} into the Keysmith dialog.`,
    ]);
  }
  let pub = publishable;
  if (!pub) {
    const p = await ctx.capture.capture({
      title: "Keysmith — Stripe",
      message: "Now paste the publishable key from the same page (pk_test_…).",
      validate: prefixValidator(["pk_test_"], "a Stripe test publishable key"),
    });
    if (!p.ok) return failed(stripe, p.message);
    pub = p.value;
  }
  return { secret: secret.value, publishable: pub, expires: null };
}

export const stripe: Recipe = {
  id: "stripe",
  displayName: "Stripe",
  envVars: [
    { name: SECRET, secret: true, description: "Test-mode secret (or restricted) key" },
    { name: PUBLISHABLE, secret: false, description: "Test-mode publishable key (public)" },
    {
      name: NEXT_PUBLISHABLE,
      secret: false,
      description: "Publishable key exposed to Next.js client code",
    },
  ],
  hosts: ["api.stripe.com"],
  tiers: ["cli", "capture"],
  humanSteps: [
    "Approve a pairing code in the browser (Stripe CLI sign-in), unless the Stripe CLI is already signed in.",
    `If the Stripe CLI isn't installed, the user must approve installing it: ${INSTALL_CMD}`,
  ],
  blockedPaths: [/^\/v\d+\/(api_keys|iam)\b/],

  async detect(ctx) {
    return detectFromState(ctx, this);
  },

  async connect(ctx) {
    const status = await this.detect(ctx);
    if (status.state === "connected" && !ctx.options.force) return alreadyConnected(this, status);
    const repaired = repairEnv(ctx, this, status);
    if (repaired) return repaired;

    const warnings: string[] = [];
    let keys: CliKeys | ConnectResult;
    let tier: Tier = "cli";

    if (ctx.options.tier === "capture") {
      keys = await captureKeys(ctx);
      tier = "capture";
    } else if (!(await ctx.sys.which("stripe"))) {
      return {
        service: this.id,
        outcome: "action_required",
        message: `The Stripe CLI is not installed. Ask the user for permission, then run \`${INSTALL_CMD}\` and call connect again. (Alternative: connect with tier "capture" to paste a key instead.)`,
        humanSteps: [`Approve installing the Stripe CLI: ${INSTALL_CMD}`],
      };
    } else {
      const fromCli = await ensureCliLogin(ctx);
      if (fromCli === CLI_KEYS_UNAVAILABLE) {
        warnings.push(
          "The Stripe CLI signed in but no longer stores test keys in config.toml, so Keysmith asked you to paste a dashboard key instead.",
        );
        keys = await captureKeys(ctx);
        tier = "capture";
      } else {
        keys = fromCli;
      }
    }
    if ("outcome" in keys) return { ...keys, warnings: warnings.length ? warnings : undefined };

    if (!keys.secret || !TEST_SECRET.test(keys.secret)) {
      return failed(
        this,
        "The Stripe key is not a test-mode key. Keysmith only stores test keys in this version.",
      );
    }
    if (keys.publishable && !TEST_PUBLISHABLE.test(keys.publishable)) keys.publishable = undefined;

    let check = await checkKey(ctx, keys.secret);
    if (check.ok && check.canCheckout === false && tier === "cli") {
      warnings.push(
        "The Stripe CLI key can't create Checkout Sessions, so Keysmith asked for a dashboard key instead.",
      );
      const captured = await captureKeys(ctx, keys.publishable);
      if ("outcome" in captured) return { ...captured, warnings };
      keys = { ...captured, account: keys.account };
      tier = "capture";
      check = await checkKey(ctx, keys.secret!);
    }
    if (!check.ok) return failed(this, check.message);
    if (!keys.publishable) {
      return failed(this, "No test publishable key was found.", [
        `Copy the publishable key from ${KEYS_PAGE}.`,
      ]);
    }

    const account = check.account ?? (keys.account ? { id: keys.account } : undefined);
    const envVars = persist(ctx, this, [
      {
        envVar: SECRET,
        value: keys.secret!,
        meta: {
          mode: "test",
          tier,
          expires: keys.expires,
          account: account?.id,
          accountName: account?.name,
        },
      },
      { envVar: PUBLISHABLE, value: keys.publishable },
      { envVar: NEXT_PUBLISHABLE, value: keys.publishable },
    ]);
    const expiry = keys.expires
      ? ` Key expires ${keys.expires.slice(0, 10)} (Stripe CLI keys last 90 days).`
      : "";
    const mismatch = await cliMismatchWarning(ctx, account);
    if (mismatch) warnings.push(mismatch);
    const where = account
      ? `, account ${accountLabel(account.id, account.name)}`
      : ". Keysmith couldn't read the account name for this key";
    return {
      service: this.id,
      outcome: "connected",
      message: `Stripe connected in test mode${where}.${expiry}`,
      tier,
      envVars,
      account: account?.id,
      accountName: account?.name,
      mode: "test",
      expires: keys.expires,
      warnings: warnings.length ? warnings : undefined,
    };
  },

  async verify(ctx): Promise<VerifyResult> {
    const ref = refFor(ctx, this, SECRET);
    const key = ctx.vault.resolve(ref);
    if (!key) return { service: this.id, ok: false, message: "Not connected. Call connect first." };
    const check = await checkKey(ctx, key);
    if (!check.ok) return { service: this.id, ok: false, message: check.message };
    const meta = ctx.vault.meta(ref);
    const account =
      check.account ?? (meta?.account ? { id: meta.account, name: meta.accountName } : undefined);
    // Backfill connections made before the account was recorded, so `status` can show it.
    if (account && (meta?.account !== account.id || meta?.accountName !== account.name))
      ctx.vault.updateMeta(ref, { account: account.id, accountName: account.name });
    const notes = check.canCheckout ? "" : " Note: this key can't create Checkout Sessions.";
    const mismatch = await cliMismatchWarning(ctx, account);
    return {
      service: this.id,
      ok: true,
      message: `STRIPE_SECRET_KEY works (test mode${account ? `, account ${accountLabel(account.id, account.name)}` : ""}).${notes}`,
      account: account?.id,
      accountName: account?.name,
      mode: "test",
      warnings: mismatch ? [mismatch] : undefined,
    };
  },

  /** CLI keys rotate by signing in again; this picks up a newer key from the CLI. */
  async rotate(ctx): Promise<ConnectResult> {
    const ref = refFor(ctx, this, SECRET);
    const meta = ctx.vault.meta(ref);
    const current = ctx.vault.resolve(ref);
    if (!meta || !current) return failed(this, "Stripe is not connected. Call connect first.");
    if (meta.tier !== "cli") {
      return failed(
        this,
        "This key was pasted from the dashboard; roll it there and run connect --tier capture.",
        [`Roll the key at ${KEYS_PAGE}`],
      );
    }
    const keys = readCliConfig(ctx, profileName(ctx));
    if (!keys?.secret || keys.secret === current || !TEST_SECRET.test(keys.secret)) {
      return {
        service: this.id,
        outcome: "action_required",
        message:
          "The Stripe CLI still holds the same key. Have the user run `stripe login` to mint a new one, then call rotate again.",
        humanSteps: ["Run `stripe login` in a terminal and approve the pairing code."],
      };
    }
    const check = await checkKey(ctx, keys.secret);
    if (!check.ok)
      return failed(this, `The new CLI key didn't verify (${check.message}). Nothing changed.`);
    ctx.vault.set(ref, keys.secret, {
      mode: "test",
      tier: "cli",
      expires: keys.expires,
      account: meta.account,
      accountName: meta.accountName,
    });
    return {
      service: this.id,
      outcome: "connected",
      message: "Stripe key rotated ✓ Restart running processes to pick it up.",
      tier: "cli",
      envVars: [SECRET],
      expires: keys.expires,
      mode: "test",
    };
  },

  auth(ctx) {
    const ref = refFor(ctx, this, SECRET);
    const key = ctx.vault.resolve(ref);
    if (!key) return null;
    return {
      headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` },
      secrets: [key],
      mode: ctx.vault.meta(ref)?.mode ?? "test",
    };
  },

  encodeBody(body) {
    return { body: formEncode(body), contentType: "application/x-www-form-urlencoded" };
  },
};

/** Stripe's form encoding: a[b]=c, a[0]=x. */
export function formEncode(value: unknown): string {
  const params = new URLSearchParams();
  const walk = (prefix: string, v: unknown): void => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((item, i) => walk(`${prefix}[${i}]`, item));
    else if (typeof v === "object") {
      for (const [k, inner] of Object.entries(v)) walk(prefix ? `${prefix}[${k}]` : k, inner);
    } else params.append(prefix, String(v));
  };
  walk("", value);
  return params.toString();
}
