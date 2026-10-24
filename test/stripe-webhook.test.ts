import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripeWebhook } from "../src/recipes/stripe-webhook.js";
import { fakeSys, makeCtx } from "./fakes.js";

const WHSEC = "whsec_FakeSigningSecretABCDEFGHIJKLMNOP";
const KEY_REF = "keysmith://demo/stripe/STRIPE_SECRET_KEY";

const cli = (opts: { account?: string; secret?: string | null } = {}) => {
  const state = { secret: opts.secret === undefined ? WHSEC : opts.secret };
  const sys = fakeSys({
    which: { stripe: "/usr/bin/stripe" },
    exec: (_cmd, args) => {
      if (args[0] === "get" && args[1] === "/v1/account")
        return {
          code: 0,
          stdout: JSON.stringify({
            id: opts.account ?? "acct_Sandbox1",
            settings: { dashboard: { display_name: "Gap Detector sandbox" } },
          }),
          stderr: "",
        };
      if (args[0] === "listen" && args.includes("--print-secret"))
        return state.secret
          ? { code: 0, stdout: `${state.secret}\n`, stderr: "" }
          : { code: 1, stdout: "", stderr: "not logged in" };
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  return { sys, state };
};

describe("stripe-webhook recipe", () => {
  it("stores the signing secret from the Stripe CLI and writes a placeholder", async () => {
    const { sys } = cli();
    const { ctx, root, keychain } = makeCtx({ sys });
    const r = await stripeWebhook.connect(ctx);
    expect(r).toMatchObject({ outcome: "connected", account: "acct_Sandbox1" });
    expect(r.message).toMatch(/keysmith run -- stripe listen/);
    expect(keychain.items.get("demo/stripe-webhook/STRIPE_WEBHOOK_SECRET")).toBe(WHSEC);
    const env = readFileSync(join(root, ".env"), "utf8");
    expect(env).toContain(
      "STRIPE_WEBHOOK_SECRET=keysmith://demo/stripe-webhook/STRIPE_WEBHOOK_SECRET",
    );
    expect(env + JSON.stringify(r)).not.toContain(WHSEC);
    expect((await stripeWebhook.connect(ctx)).outcome).toBe("already_connected");
  });

  it("refuses when the CLI is on a different account from the Stripe key", async () => {
    const { sys } = cli({ account: "acct_Main1" });
    const { ctx, keychain, vault } = makeCtx({ sys });
    vault.set(KEY_REF, "sk_test_51KeyABCDEFGHIJKL", {
      mode: "test",
      tier: "capture",
      expires: null,
      account: "acct_Sandbox1",
      accountName: "Gap Detector sandbox",
    });
    const r = await stripeWebhook.connect(ctx);
    expect(r.outcome).toBe("failed");
    expect(r.message).toMatch(/stripe switch acct_Sandbox1/);
    expect(keychain.items.has("demo/stripe-webhook/STRIPE_WEBHOOK_SECRET")).toBe(false);
  });

  it("fails clearly when the CLI has no secret", async () => {
    const { sys } = cli({ secret: null });
    const { ctx } = makeCtx({ sys });
    const r = await stripeWebhook.connect(ctx);
    expect(r.outcome).toBe("failed");
    expect(r.humanSteps?.[0]).toMatch(/stripe login/);
  });

  it("verifies against the CLI's current secret without returning either", async () => {
    const { sys, state } = cli();
    const { ctx } = makeCtx({ sys });
    await stripeWebhook.connect(ctx);
    const ok = await stripeWebhook.verify(ctx);
    expect(ok.ok).toBe(true);

    state.secret = "whsec_SomeOtherAccountSecretABCDEFGH";
    const changed = await stripeWebhook.verify(ctx);
    expect(changed.ok).toBe(false);
    expect(changed.message).toMatch(/--force/);
    expect(JSON.stringify([ok, changed])).not.toMatch(/whsec_/);
  });

  it("never proxies requests", () => {
    const { ctx } = makeCtx({});
    expect(stripeWebhook.auth(ctx)).toBeNull();
  });
});
