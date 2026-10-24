import { prefixValidator } from "../capture/index.js";
import { envPath, readEnvFile } from "../env/index.js";
import { isRef, type Tier } from "../vault/index.js";
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

const GITHUB_TOKEN = "GITHUB_TOKEN";
const HOST = "api.github.com";
/** Creating a fine-grained token, the least-privilege option. */
const TOKEN_PAGE = "https://github.com/settings/personal-access-tokens/new";
/** https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github */
const PREFIXES = ["github_pat_", "ghp_", "gho_", "ghu_"];
/** Scopes that can delete or administer; see GitHub's "Scopes for OAuth apps". */
const BROAD_SCOPES = [
  "delete_repo",
  "delete:packages",
  "admin:org",
  "admin:repo_hook",
  "admin:org_hook",
  "admin:public_key",
  "admin:gpg_key",
];
const API_HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

const validate = prefixValidator(PREFIXES, "a GitHub token");

interface Check {
  ok: boolean;
  message?: string;
  login?: string;
  id?: string;
  /** Classic and OAuth tokens only; fine-grained tokens send no X-OAuth-Scopes header. */
  scopes?: string[];
}

/** GET /user works with every token type, fine-grained ones included, and changes nothing. */
async function check(ctx: RecipeContext, token: string): Promise<Check> {
  const res = await ctx.fetch(`https://${HOST}/user`, {
    headers: { Authorization: `Bearer ${token}`, ...API_HEADERS, "User-Agent": "keysmith/0.1" },
  });
  if (!res.ok) return { ok: false, message: await describeHttpError(res) };
  const body = (await res.json()) as { login?: string; id?: number };
  const header = res.headers.get("x-oauth-scopes");
  return {
    ok: true,
    login: body.login,
    id: body.id === undefined ? undefined : String(body.id),
    scopes:
      header === null
        ? undefined
        : header
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
  };
}

function scopeWarnings(c: Check, tier: Tier): string[] {
  const warnings: string[] = [];
  const broad = (c.scopes ?? []).filter((s) => BROAD_SCOPES.includes(s));
  if (broad.length)
    warnings.push(`This token can delete or administer things (scopes: ${broad.join(", ")}).`);
  if (tier === "cli")
    warnings.push(
      `This is your GitHub CLI token${c.scopes ? ` (scopes: ${c.scopes.join(", ") || "none"})` : ""}, so the app gets everything \`gh\` can do. For least privilege, create a fine-grained token at ${TOKEN_PAGE} and run \`keysmith connect github --force --tier capture\`.`,
    );
  return warnings;
}

/** The GitHub CLI's token for github.com, read in-process. */
async function cliToken(
  ctx: RecipeContext,
): Promise<{ token: string } | { result: ConnectResult } | null> {
  if (ctx.options.tier === "capture" || !(await ctx.sys.which("gh"))) return null;
  const r = await ctx.sys.exec("gh", ["auth", "token", "--hostname", "github.com"], {
    timeoutMs: 30_000,
  });
  const token = r.stdout.trim();
  if (r.code === 0 && !validate(token)) return { token };
  return {
    result: {
      service: github.id,
      outcome: "action_required",
      message:
        'The GitHub CLI isn\'t signed in. Ask the user to run `gh auth login` in a terminal, then call connect again. (Alternative: connect with tier "capture" to paste a fine-grained token instead.)',
      humanSteps: ["Run `gh auth login` in a terminal and approve it in the browser."],
    },
  };
}

export const github: Recipe = {
  id: "github",
  displayName: "GitHub",
  support: "dedicated",
  docsUrl: "https://docs.github.com/en/rest/users/users#get-the-authenticated-user",
  verifiedWith: `GET ${HOST}/user`,
  envVars: [{ name: GITHUB_TOKEN, secret: true, description: "GitHub token" }],
  hosts: [HOST],
  tiers: ["cli", "capture"],
  humanSteps: [
    "Sign in with `gh auth login`, unless the GitHub CLI is already signed in.",
    `Without the GitHub CLI (or with --tier capture): paste a fine-grained token from ${TOKEN_PAGE} into a hidden macOS dialog.`,
  ],
  signals: { packages: ["octokit", "@octokit/rest", "@octokit/core"] },
  rotation:
    "Not automatic: run `gh auth refresh` (CLI token) or regenerate the fine-grained token, then `keysmith connect github --force`.",
  // Key, secret and token management; the proxy refuses these.
  blockedPaths: [
    /^\/(authorizations|applications|installation)\b/,
    /^\/user\/(keys|gpg_keys|ssh_signing_keys)\b/,
    /\/(keys|secrets|personal-access-tokens|personal-access-token-requests)(\/|$)/,
    /\/actions\/runners\/(registration|remove)-token$/,
  ],

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
    const existing = readEnvFile(envPath(ctx.project.root)).get(GITHUB_TOKEN);
    const adopt =
      existing && !isRef(existing) && !ctx.options.force && !validate(existing)
        ? existing
        : undefined;
    const fromCli = adopt ? null : await cliToken(ctx);
    if (adopt) {
      // A real token already in .env: move it into the Keychain instead of asking.
      token = adopt;
      tier = "imported";
    } else if (fromCli && "result" in fromCli) {
      return fromCli.result;
    } else if (fromCli) {
      token = fromCli.token;
      tier = "cli";
    } else {
      ctx.progress(`Opening ${TOKEN_PAGE}. Paste the token into the dialog.`);
      const r = await ctx.capture.capture({
        title: "Keysmith — GitHub",
        message:
          "Paste a GitHub fine-grained token (GITHUB_TOKEN). Give it only the repositories and permissions the app needs. It goes straight to your macOS Keychain.",
        url: TOKEN_PAGE,
        validate,
      });
      if (!r.ok) return failed(this, r.message, [`Create a fine-grained token at ${TOKEN_PAGE}.`]);
      token = r.value;
      tier = "capture";
    }

    const c = await check(ctx, token);
    if (!c.ok) return failed(this, `GitHub rejected the token (${c.message}). Nothing was saved.`);
    const envVars = persist(ctx, this, [
      {
        envVar: GITHUB_TOKEN,
        value: token,
        meta: { mode: "live", tier, expires: null, account: c.id, accountName: c.login },
      },
    ]);
    const warnings = scopeWarnings(c, tier);
    return {
      service: this.id,
      outcome: "connected",
      message: `GitHub connected as ${c.id ? accountLabel(c.id, c.login) : "an unknown user"}.${tier === "imported" ? " Moved GITHUB_TOKEN from .env into the Keychain." : ""}`,
      tier,
      envVars,
      account: c.id,
      accountName: c.login,
      mode: "live",
      warnings: warnings.length ? warnings : undefined,
    };
  },

  async verify(ctx): Promise<VerifyResult> {
    const token = ctx.vault.resolve(refFor(ctx, this, GITHUB_TOKEN));
    if (!token)
      return { service: this.id, ok: false, message: "Not connected. Call connect first." };
    const c = await check(ctx, token);
    if (!c.ok)
      return { service: this.id, ok: false, message: `GitHub rejected the token (${c.message}).` };
    const tier = ctx.vault.meta(refFor(ctx, this, GITHUB_TOKEN))?.tier ?? "capture";
    const warnings = scopeWarnings(c, tier);
    return {
      service: this.id,
      ok: true,
      message: `GITHUB_TOKEN works (user ${c.login ?? "unknown"}).`,
      account: c.id,
      accountName: c.login,
      mode: "live",
      warnings: warnings.length ? warnings : undefined,
    };
  },

  auth(ctx) {
    const token = ctx.vault.resolve(refFor(ctx, this, GITHUB_TOKEN));
    if (!token) return null;
    // GitHub has no test mode, so the proxy refuses every write.
    return {
      headers: { Authorization: `Bearer ${token}`, ...API_HEADERS },
      secrets: [token],
      mode: "live",
    };
  },
};
