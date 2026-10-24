import {
  accountLabel,
  alreadyConnected,
  detectFromState,
  failed,
  persist,
  refFor,
  repairEnv,
} from "./common.js";
import { type Account, cliAccount, profileArgs } from "./stripe.js";
import type { ConnectResult, Recipe, RecipeContext, VerifyResult } from "./types.js";

const SECRET = "STRIPE_WEBHOOK_SECRET";
const WHSEC = /\bwhsec_[A-Za-z0-9]{10,}\b/;
const INSTALL_CMD = "brew install stripe/stripe-cli/stripe";
const LISTEN_HINT =
  "Forward events with `keysmith run -- stripe listen --forward-to localhost:3000/<your webhook route>`. Running it through keysmith redacts the secret stripe listen prints.";

/**
 * The signing secret `stripe listen` uses for this account. Read in-process from
 * `--print-secret`, so it never reaches the agent, the terminal or the transcript.
 */
async function cliSigningSecret(ctx: RecipeContext): Promise<string | null> {
  const r = await ctx.sys.exec("stripe", ["listen", "--print-secret", ...profileArgs(ctx)], {
    timeoutMs: 30_000,
  });
  return r.code === 0 ? (WHSEC.exec(r.stdout)?.[0] ?? null) : null;
}

/** The account Keysmith's Stripe key belongs to, if Stripe is connected and it's known. */
function keyAccount(ctx: RecipeContext): Account | undefined {
  const meta = ctx.vault.meta(ctx.vault.ref(ctx.project.name, "stripe", "STRIPE_SECRET_KEY"));
  return meta?.account ? { id: meta.account, name: meta.accountName } : undefined;
}

function mismatch(cli: Account, key: Account): string {
  return (
    `The Stripe CLI is using ${accountLabel(cli.id, cli.name)}, but Keysmith's Stripe key belongs to ` +
    `${accountLabel(key.id, key.name)}, so webhooks would be signed for the wrong account. ` +
    `Run \`stripe switch ${key.id}\` (after \`stripe login\` if needed), then connect again.`
  );
}

export const stripeWebhook: Recipe = {
  id: "stripe-webhook",
  displayName: "Stripe webhooks",
  envVars: [
    {
      name: SECRET,
      secret: true,
      description: "Signing secret for events forwarded by `stripe listen` (test mode)",
    },
  ],
  // Only a signing secret: nothing to proxy.
  hosts: [],
  tiers: ["cli"],
  humanSteps: [
    "None if the Stripe CLI is signed in to the same account as the Stripe key. Otherwise the user runs `stripe switch` or `stripe login`.",
  ],

  async detect(ctx) {
    return detectFromState(ctx, this);
  },

  async connect(ctx): Promise<ConnectResult> {
    const status = await this.detect(ctx);
    if (status.state === "connected" && !ctx.options.force) return alreadyConnected(this, status);
    const repaired = repairEnv(ctx, this, status);
    if (repaired) return repaired;

    if (!(await ctx.sys.which("stripe"))) {
      return {
        service: this.id,
        outcome: "action_required",
        message: `The Stripe CLI is not installed. Ask the user for permission, then run \`${INSTALL_CMD}\` and call connect again.`,
        humanSteps: [`Approve installing the Stripe CLI: ${INSTALL_CMD}`],
      };
    }
    const cli = await cliAccount(ctx);
    const key = keyAccount(ctx);
    if (cli && key && cli.id !== key.id) return failed(this, mismatch(cli, key));

    const secret = await cliSigningSecret(ctx);
    if (!secret) {
      return failed(
        this,
        "The Stripe CLI didn't return a webhook signing secret. It may not be signed in.",
        ["Run `stripe login` in a terminal and approve the pairing code."],
      );
    }
    const account = cli ?? key;
    const envVars = persist(ctx, this, [
      {
        envVar: SECRET,
        value: secret,
        meta: {
          mode: "test",
          tier: "cli",
          expires: null,
          account: account?.id,
          accountName: account?.name,
        },
      },
    ]);
    return {
      service: this.id,
      outcome: "connected",
      message: `Stripe webhook signing secret stored${account ? ` for ${accountLabel(account.id, account.name)}` : ""}. ${LISTEN_HINT}`,
      tier: "cli",
      envVars,
      account: account?.id,
      accountName: account?.name,
      mode: "test",
    };
  },

  async verify(ctx): Promise<VerifyResult> {
    const stored = ctx.vault.resolve(refFor(ctx, this, SECRET));
    if (!stored)
      return { service: this.id, ok: false, message: "Not connected. Call connect first." };
    if (!(await ctx.sys.which("stripe")))
      return { service: this.id, ok: false, message: "The Stripe CLI is not installed." };
    const current = await cliSigningSecret(ctx);
    if (!current)
      return {
        service: this.id,
        ok: false,
        message: "The Stripe CLI didn't return a signing secret. Run `stripe login`.",
      };
    // Compared in-process; neither value leaves this function.
    if (current !== stored)
      return {
        service: this.id,
        ok: false,
        message:
          "STRIPE_WEBHOOK_SECRET doesn't match what `stripe listen` uses now (the CLI may be on another account). Run `keysmith connect stripe-webhook --force`.",
      };
    const cli = await cliAccount(ctx);
    const key = keyAccount(ctx);
    return {
      service: this.id,
      ok: true,
      message: `STRIPE_WEBHOOK_SECRET matches \`stripe listen\`${cli ? ` for ${accountLabel(cli.id, cli.name)}` : ""}.`,
      account: cli?.id,
      accountName: cli?.name,
      mode: "test",
      warnings: cli && key && cli.id !== key.id ? [mismatch(cli, key)] : undefined,
    };
  },

  auth() {
    return null;
  },
};
