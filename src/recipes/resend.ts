import { join } from "node:path";
import { prefixValidator } from "../capture/index.js";
import type { Tier } from "../vault/index.js";
import {
  alreadyConnected,
  describeHttpError,
  detectFromState,
  failed,
  persist,
  refFor,
  repairEnv,
} from "./common.js";
import type { ConnectResult, Recipe, RecipeContext, VerifyResult } from "./types.js";

const API = "https://api.resend.com";
const KEYS_PAGE = "https://resend.com/api-keys";
const SENDING = "RESEND_API_KEY";
const ADMIN = "RESEND_ADMIN_KEY";
const validateKey = prefixValidator(["re_"], "a Resend API key");

interface CreatedKey {
  id: string;
  token: string;
}

async function call(
  ctx: RecipeContext,
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return ctx.fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "User-Agent": "keysmith/0.1",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A full-access key can list API keys; a sending-access key can't. */
async function hasFullAccess(
  ctx: RecipeContext,
  key: string,
): Promise<{ ok: boolean; reason: string }> {
  const res = await call(ctx, key, "GET", "/api-keys");
  if (res.ok) return { ok: true, reason: "" };
  return { ok: false, reason: await describeHttpError(res) };
}

/**
 * A sending key is valid when Resend rejects a non-sending call as restricted,
 * rather than as an invalid key.
 */
async function sendingKeyWorks(ctx: RecipeContext, key: string): Promise<boolean> {
  const res = await call(ctx, key, "GET", "/domains");
  if (res.ok) return true;
  try {
    const body = (await res.json()) as { name?: string };
    return body.name === "restricted_api_key";
  } catch {
    return false;
  }
}

/**
 * Tier "cli": reuse a key saved by `resend login` (~/.config/resend/credentials.json),
 * only when exactly one key is present. Read in-process; the file is never modified.
 */
function keyFromResendCli(ctx: RecipeContext): string | null {
  const base = ctx.sys.env.XDG_CONFIG_HOME ?? join(ctx.sys.homedir(), ".config");
  const raw = ctx.sys.readFile(join(base, "resend", "credentials.json"));
  if (!raw) return null;
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string" && /^re_[A-Za-z0-9_]{10,}$/.test(v)) found.add(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  try {
    walk(JSON.parse(raw));
  } catch {
    return null;
  }
  return found.size === 1 ? [...found][0]! : null;
}

async function obtainAdminKey(
  ctx: RecipeContext,
): Promise<{ key: string; tier: Tier } | { error: ConnectResult }> {
  const existingRef = refFor(ctx, resend, ADMIN);
  const existing = ctx.vault.resolve(existingRef);
  if (existing && (await hasFullAccess(ctx, existing)).ok) {
    return { key: existing, tier: ctx.vault.meta(existingRef)?.tier ?? "capture" };
  }

  if (ctx.options.tier !== "capture") {
    const cliKey = keyFromResendCli(ctx);
    if (cliKey && (await hasFullAccess(ctx, cliKey)).ok) {
      ctx.progress("Using the full-access key saved by the Resend CLI.");
      return { key: cliKey, tier: "cli" };
    }
  }

  ctx.progress(
    "Opening resend.com/api-keys — create a Full access key and paste it into the Keychain dialog.",
  );
  const captured = await ctx.capture.capture({
    title: "Keysmith — Resend",
    message:
      'Create an API key in Resend with "Full access" (Keysmith uses it only to create a sending-only key for your app), then paste it here. It goes straight to your macOS Keychain.',
    url: KEYS_PAGE,
    validate: validateKey,
  });
  if (!captured.ok) {
    return {
      error: failed(resend, captured.message, [
        "Create a Full access API key at https://resend.com/api-keys and paste it into the Keysmith dialog.",
      ]),
    };
  }
  const access = await hasFullAccess(ctx, captured.value);
  if (!access.ok) {
    return {
      error: failed(
        resend,
        `That key can't manage API keys (${access.reason}). It needs Full access.`,
        [
          'Create a new key at https://resend.com/api-keys with permission "Full access", then run connect again.',
        ],
      ),
    };
  }
  return { key: captured.value, tier: "capture" };
}

async function createSendingKey(
  ctx: RecipeContext,
  adminKey: string,
): Promise<CreatedKey | string> {
  const name = `keysmith-${ctx.project.name}-${ctx.now().toISOString().slice(0, 10)}`;
  const res = await call(ctx, adminKey, "POST", "/api-keys", {
    name,
    permission: "sending_access",
  });
  if (!res.ok) return `Could not create a sending key (${await describeHttpError(res)}).`;
  const body = (await res.json()) as Partial<CreatedKey>;
  if (!body.id || !body.token) return "Resend returned an unexpected response when creating a key.";
  return { id: body.id, token: body.token };
}

async function domainSummary(ctx: RecipeContext, adminKey: string): Promise<string> {
  const res = await call(ctx, adminKey, "GET", "/domains");
  if (!res.ok) return "";
  const body = (await res.json()) as { data?: { name: string; status: string }[] };
  const domains = body.data ?? [];
  const verified = domains.filter((d) => d.status === "verified").map((d) => d.name);
  if (verified.length) return `Verified domains: ${verified.join(", ")}.`;
  return "No verified domains yet: you can send from onboarding@resend.dev to your own address only.";
}

export const resend: Recipe = {
  id: "resend",
  displayName: "Resend",
  envVars: [
    { name: SENDING, secret: true, description: "Sending-access API key used by the app" },
    {
      name: ADMIN,
      secret: true,
      vaultOnly: true,
      description: "Full-access key kept in the vault only, used to create/rotate sending keys",
    },
  ],
  hosts: ["api.resend.com"],
  tiers: ["cli", "capture", "derived"],
  humanSteps: [
    "Paste one Full access API key (from resend.com/api-keys) into a hidden macOS dialog, unless the Resend CLI is already logged in with one.",
  ],
  // Endpoints that mint or return key material are never proxied.
  blockedPaths: [/^\/api-keys/],
  signals: { packages: ["resend"], envPrefixes: ["RESEND_"] },
  modeLabel: "sending access",
  rotation:
    "Creates a new sending-only key with the stored full-access key, verifies it, swaps it in, then deletes the old one. Running apps must restart.",

  async detect(ctx) {
    return detectFromState(ctx, this);
  },

  async connect(ctx) {
    const status = await this.detect(ctx);
    if (status.state === "connected") return alreadyConnected(this, status);
    const repaired = repairEnv(ctx, this, status);
    if (repaired) return repaired;

    const admin = await obtainAdminKey(ctx);
    if ("error" in admin) return admin.error;

    ctx.progress("Creating a sending-access key for this project…");
    const created = await createSendingKey(ctx, admin.key);
    if (typeof created === "string") return failed(this, created);

    const meta = { mode: "test" as const, expires: null };
    const envVars = persist(ctx, this, [
      { envVar: ADMIN, value: admin.key, meta: { ...meta, tier: admin.tier } },
      {
        envVar: SENDING,
        value: created.token,
        meta: { ...meta, tier: "derived", providerKeyId: created.id },
      },
    ]);
    const domains = await domainSummary(ctx, admin.key);
    return {
      service: this.id,
      outcome: "connected",
      message:
        `Resend connected. Sending-only key stored as RESEND_API_KEY; the full-access key stays in the Keychain for rotation. ${domains}`.trim(),
      tier: admin.tier,
      envVars,
      mode: "test",
      expires: null,
      warnings: [
        "Resend has no test-mode keys: emails sent with this key are real. Until a domain is verified, Resend only delivers to your own address.",
      ],
    };
  },

  async verify(ctx): Promise<VerifyResult> {
    const sending = ctx.vault.resolve(refFor(ctx, this, SENDING));
    if (!sending)
      return { service: this.id, ok: false, message: "Not connected. Call connect first." };
    if (!(await sendingKeyWorks(ctx, sending))) {
      return {
        service: this.id,
        ok: false,
        message: "Resend rejected RESEND_API_KEY. Run rotate or connect again.",
      };
    }
    const admin = ctx.vault.resolve(refFor(ctx, this, ADMIN));
    const domains = admin ? await domainSummary(ctx, admin) : "";
    return {
      service: this.id,
      ok: true,
      message: `RESEND_API_KEY is valid (sending access). ${domains}`.trim(),
      mode: "test",
    };
  },

  async rotate(ctx): Promise<ConnectResult> {
    const sendingRef = refFor(ctx, this, SENDING);
    const oldMeta = ctx.vault.meta(sendingRef);
    const admin = ctx.vault.resolve(refFor(ctx, this, ADMIN));
    if (!oldMeta || !admin)
      return failed(
        this,
        "Resend is not connected (or the admin key is missing). Call connect first.",
      );
    const access = await hasFullAccess(ctx, admin);
    if (!access.ok)
      return failed(this, `The stored full-access key no longer works (${access.reason}).`);

    const created = await createSendingKey(ctx, admin);
    if (typeof created === "string") return failed(this, created);
    if (!(await sendingKeyWorks(ctx, created.token))) {
      await call(ctx, admin, "DELETE", `/api-keys/${created.id}`);
      return failed(this, "The new key didn't verify; nothing was changed.");
    }
    ctx.vault.set(sendingRef, created.token, {
      mode: oldMeta.mode,
      tier: "derived",
      expires: null,
      providerKeyId: created.id,
    });

    const warnings: string[] = [];
    if (oldMeta.providerKeyId) {
      const del = await call(ctx, admin, "DELETE", `/api-keys/${oldMeta.providerKeyId}`);
      if (!del.ok && del.status !== 404) {
        warnings.push(
          `Could not delete the old key ${oldMeta.providerKeyId} (${await describeHttpError(del)}). Delete it at ${KEYS_PAGE}.`,
        );
      }
    }
    warnings.push("Restart running processes (keysmith run …) so they pick up the new key.");
    return {
      service: this.id,
      outcome: "connected",
      message: "Resend key rotated. New sending key verified and stored; old key revoked.",
      tier: "derived",
      envVars: [SENDING],
      mode: oldMeta.mode,
      warnings,
    };
  },

  auth(ctx) {
    // Prefer the admin key so read endpoints (domains, emails) work; it never leaves this process.
    const key =
      ctx.vault.resolve(refFor(ctx, this, ADMIN)) ?? ctx.vault.resolve(refFor(ctx, this, SENDING));
    if (!key) return null;
    return { headers: { Authorization: `Bearer ${key}` }, secrets: [key], mode: "test" };
  },
};
