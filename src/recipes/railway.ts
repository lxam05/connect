import { envPath, readEnvFile } from "../env/index.js";
import { isRef, type Tier } from "../vault/index.js";
import { validatorFor } from "./paste.js";
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

/**
 * Railway project tokens are scoped to one environment of one project, the least privilege
 * Railway offers. They can only be created in the dashboard: neither the CLI nor the public
 * API documents a way to create or print one, so the user pastes it once.
 * Docs: https://docs.railway.com/reference/public-api
 */
const RAILWAY_TOKEN = "RAILWAY_TOKEN";
const GRAPHQL = "https://backboard.railway.com/graphql/v2";
const DASHBOARD = "https://railway.com/dashboard";

const validate = validatorFor(
  { name: RAILWAY_TOKEN, secret: true, description: "project token" },
  "a Railway project token",
);

type Check =
  { ok: true; projectId: string; environmentId: string } | { ok: false; message: string };

/** The documented read-only query that identifies a project token. */
async function check(ctx: RecipeContext, token: string): Promise<Check> {
  const res = await ctx.fetch(GRAPHQL, {
    method: "POST",
    headers: {
      "Project-Access-Token": token,
      "Content-Type": "application/json",
      "User-Agent": "keysmith/0.1",
    },
    body: JSON.stringify({ query: "query { projectToken { projectId environmentId } }" }),
  });
  if (!res.ok) return { ok: false, message: await describeHttpError(res) };
  const body = (await res.json()) as {
    data?: { projectToken?: { projectId?: string; environmentId?: string } | null };
    errors?: { message?: string }[];
  };
  const t = body.data?.projectToken;
  if (t?.projectId && t.environmentId)
    return { ok: true, projectId: t.projectId, environmentId: t.environmentId };
  return { ok: false, message: body.errors?.[0]?.message ?? "not a project token" };
}

export const railway: Recipe = {
  id: "railway",
  displayName: "Railway",
  support: "verified-paste",
  docsUrl: "https://docs.railway.com/reference/public-api",
  verifiedWith: "POST backboard.railway.com/graphql/v2 (projectToken query)",
  envVars: [
    {
      name: RAILWAY_TOKEN,
      secret: true,
      description: "Railway project token (one environment of one project)",
    },
  ],
  hosts: [],
  // No test mode: every token is live, so the proxy refuses writes.
  modeFor: () => "live",
  tiers: ["capture"],
  humanSteps: [
    `Create a project token in your Railway project's Settings → Tokens (${DASHBOARD}) and paste it into a hidden macOS dialog.`,
  ],
  signals: { packages: [] },
  rotation:
    "Not automatic: create a new project token in the dashboard, run `keysmith connect railway --force`, then delete the old token.",

  async detect(ctx) {
    return detectFromState(ctx, this);
  },

  async connect(ctx): Promise<ConnectResult> {
    const status = await this.detect(ctx);
    if (status.state === "connected" && !ctx.options.force) return alreadyConnected(this, status);
    const repaired = repairEnv(ctx, this, status);
    if (repaired) return repaired;

    let token: string;
    let tier: Tier;
    const existing = readEnvFile(envPath(ctx.project.root)).get(RAILWAY_TOKEN);
    if (existing && !isRef(existing) && !ctx.options.force && !validate(existing)) {
      // A real token already in .env: move it into the Keychain instead of asking.
      token = existing;
      tier = "imported";
    } else {
      ctx.progress(`Opening ${DASHBOARD}. Paste the project token into the dialog.`);
      const r = await ctx.capture.capture({
        title: "Keysmith — Railway",
        message:
          "Paste a Railway project token (RAILWAY_TOKEN), from your project's Settings → Tokens. It goes straight to your macOS Keychain.",
        url: DASHBOARD,
        validate,
      });
      if (!r.ok) return failed(this, r.message, [`Create a project token at ${DASHBOARD}.`]);
      token = r.value;
      tier = "capture";
    }

    const c = await check(ctx, token);
    if (!c.ok)
      return failed(
        this,
        `Railway rejected the token (${c.message}). Nothing was saved. Account and workspace tokens don't work here: use a project token.`,
      );
    const accountName = `environment ${c.environmentId}`;
    const envVars = persist(ctx, this, [
      {
        envVar: RAILWAY_TOKEN,
        value: token,
        meta: { mode: "live", tier, expires: null, account: c.projectId, accountName },
      },
    ]);
    return {
      service: this.id,
      outcome: "connected",
      message: `Railway connected: project ${c.projectId}, ${accountName}.${tier === "imported" ? " Moved RAILWAY_TOKEN from .env into the Keychain." : ""} Run the CLI as \`keysmith run -- railway up\`.`,
      tier,
      envVars,
      account: c.projectId,
      accountName,
      mode: "live",
    };
  },

  async verify(ctx): Promise<VerifyResult> {
    const token = ctx.vault.resolve(refFor(ctx, this, RAILWAY_TOKEN));
    if (!token)
      return { service: this.id, ok: false, message: "Not connected. Call connect first." };
    const c = await check(ctx, token);
    if (!c.ok)
      return { service: this.id, ok: false, message: `Railway rejected the token (${c.message}).` };
    return {
      service: this.id,
      ok: true,
      message: `RAILWAY_TOKEN works (project ${c.projectId}, environment ${c.environmentId}).`,
      account: c.projectId,
      accountName: `environment ${c.environmentId}`,
      mode: "live",
    };
  },

  // Railway's API is GraphQL over POST, and the proxy refuses POST on live keys. Agents use
  // the CLI through `keysmith run` instead.
  auth() {
    return null;
  },
};
