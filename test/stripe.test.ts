import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formEncode, parseNextStep, stripe } from "../src/recipes/stripe.js";
import { FakeCapture, type Route, fakeFetch, fakeSys, json, makeCtx } from "./fakes.js";

const SK = "rk_test_51CliRestrictedKeyABCDEFGHIJ";
const PK = "pk_test_51PublishableKeyABCDEFGHIJ";
const CONFIG_PATH = "/home/test/.config/stripe/config.toml";
const config = (sk = SK, expires = "2027-01-21") =>
  `[default]\naccount_id = "acct_123"\ntest_mode_api_key = "${sk}"\ntest_mode_pub_key = "${PK}"\ntest_mode_key_expires_at = "${expires}"\n`;

const stripeApi =
  (opts: { checkout?: boolean; livemode?: boolean } = {}): Route =>
  ({ url, headers }) => {
    if (url.host !== "api.stripe.com") return undefined;
    const auth = headers.get("authorization") ?? "";
    const key = Buffer.from(auth.replace("Basic ", ""), "base64").toString().replace(/:$/, "");
    if (!/^(sk|rk)_test_/.test(key))
      return json({ error: { message: "Invalid API Key provided" } }, 401);
    if (url.pathname === "/v1/balance")
      return json({ object: "balance", livemode: opts.livemode ?? false });
    if (url.pathname === "/v1/checkout/sessions") {
      return opts.checkout === false
        ? json({ error: { message: "restricted" } }, 403)
        : json({ data: [] });
    }
    return undefined;
  };

describe("stripe recipe", () => {
  it("reads keys from a logged-in Stripe CLI and writes placeholders + public keys", async () => {
    const sys = fakeSys({
      which: { stripe: "/opt/homebrew/bin/stripe" },
      files: { [CONFIG_PATH]: config() },
    });
    const { ctx, root, keychain, vault } = makeCtx({ sys, fetch: fakeFetch([stripeApi()]).fetch });
    const r = await stripe.connect(ctx);
    expect(r.outcome).toBe("connected");
    expect(r.account).toBe("acct_123");
    expect(r.expires?.slice(0, 10)).toBe("2027-01-21");
    const env = readFileSync(join(root, ".env"), "utf8");
    expect(env).toContain("STRIPE_SECRET_KEY=keysmith://demo/stripe/STRIPE_SECRET_KEY");
    expect(env).toContain(`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=${PK}`);
    expect(env).not.toContain(SK);
    expect(keychain.items.get("demo/stripe/STRIPE_SECRET_KEY")).toBe(SK);
    expect(vault.meta("keysmith://demo/stripe/STRIPE_SECRET_KEY")).toMatchObject({
      tier: "cli",
      mode: "test",
    });
    expect(JSON.stringify(r)).not.toContain(SK);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toMatch(/^\.env$/m);

    const again = await stripe.connect(ctx);
    expect(again.outcome).toBe("already_connected");
  });

  it("asks before installing the CLI", async () => {
    const { ctx } = makeCtx({ sys: fakeSys() });
    const r = await stripe.connect(ctx);
    expect(r.outcome).toBe("action_required");
    expect(r.humanSteps?.[0]).toMatch(/brew install stripe\/stripe-cli\/stripe/);
  });

  it("starts a non-interactive login and returns the pairing code", async () => {
    let finish: () => void = () => {};
    const files: Record<string, string> = {};
    const sys = fakeSys({
      which: { stripe: "/usr/bin/stripe" },
      files,
      exec: (_cmd, args) =>
        args.includes("--non-interactive")
          ? {
              code: 0,
              stdout: JSON.stringify({
                browser_url: "https://dashboard.stripe.com/stripecli/confirm_auth?t=abc",
                verification_code: "lucky-happy-mango-tree",
                next_step:
                  "stripe login --complete 'https://dashboard.stripe.com/stripecli/auth/poll?t=abc'",
              }),
              stderr: "",
            }
          : { code: 1, stdout: "", stderr: "" },
      background: () =>
        new Promise((resolve) => {
          finish = () => {
            files[CONFIG_PATH] = config();
            resolve({ code: 0, stdout: "", stderr: "" });
          };
        }),
    });
    const { ctx } = makeCtx({ sys, fetch: fakeFetch([stripeApi()]).fetch });
    const first = await stripe.connect(ctx);
    expect(first.outcome).toBe("action_required");
    expect(first.humanSteps?.[0]).toContain("lucky-happy-mango-tree");
    expect(sys.opened).toEqual(["https://dashboard.stripe.com/stripecli/confirm_auth?t=abc"]);
    expect(sys.calls.at(-1)).toEqual([
      "stripe",
      "login",
      "--complete",
      "https://dashboard.stripe.com/stripecli/auth/poll?t=abc",
    ]);

    const waiting = await stripe.connect(ctx);
    expect(waiting.outcome).toBe("action_required");

    finish();
    await new Promise((r) => setTimeout(r, 0));
    const done = await stripe.connect(ctx);
    expect(done.outcome).toBe("connected");
  });

  it("falls back to secure capture when the signed-in CLI exposes no key", async () => {
    const sys = fakeSys({
      which: { stripe: "/usr/bin/stripe" },
      files: { [CONFIG_PATH]: `[default]\naccount_id = "acct_123"\n` },
    });
    const dashboardKey = "sk_test_51DashboardKeyABCDEFGHIJKL";
    const capture = new FakeCapture([dashboardKey, PK]);
    const { ctx, keychain } = makeCtx({ sys, capture, fetch: fakeFetch([stripeApi()]).fetch });
    const r = await stripe.connect(ctx);
    expect(r.outcome).toBe("connected");
    expect(r.tier).toBe("capture");
    expect(sys.calls).toEqual([]); // no new sign-in started
    expect(capture.requests[0]!.url).toBe("https://dashboard.stripe.com/test/apikeys");
    expect(keychain.items.get("demo/stripe/STRIPE_SECRET_KEY")).toBe(dashboardKey);
  });

  it("treats an expired CLI key as logged out", async () => {
    const sys = fakeSys({
      which: { stripe: "/usr/bin/stripe" },
      files: { [CONFIG_PATH]: config(SK, "2026-01-01") },
      exec: () => ({ code: 1, stdout: "nope", stderr: "" }),
    });
    const { ctx } = makeCtx({ sys });
    const r = await stripe.connect(ctx);
    expect(r.outcome).toBe("failed");
    expect(sys.calls[0]).toContain("--non-interactive");
  });

  it("refuses live keys", async () => {
    const sys = fakeSys({
      which: { stripe: "/usr/bin/stripe" },
      files: { [CONFIG_PATH]: config("sk_live_51LiveKeyABCDEFGHIJKLMN") },
    });
    const { ctx, keychain } = makeCtx({ sys, fetch: fakeFetch([stripeApi()]).fetch });
    const r = await stripe.connect(ctx);
    expect(r.outcome).toBe("failed");
    expect(keychain.items.size).toBe(0);
  });

  it("falls back to secure capture when the CLI key can't create Checkout Sessions", async () => {
    const sys = fakeSys({
      which: { stripe: "/usr/bin/stripe" },
      files: { [CONFIG_PATH]: config() },
    });
    const dashboardKey = "sk_test_51DashboardKeyABCDEFGHIJKL";
    let calls = 0;
    const route: Route = (req) => {
      if (req.url.pathname === "/v1/checkout/sessions") {
        calls++;
        return calls === 1 ? json({ error: { message: "restricted" } }, 403) : json({ data: [] });
      }
      return stripeApi()(req);
    };
    const capture = new FakeCapture([dashboardKey]);
    const { ctx, keychain } = makeCtx({ sys, capture, fetch: fakeFetch([route]).fetch });
    const r = await stripe.connect(ctx);
    expect(r.outcome).toBe("connected");
    expect(r.tier).toBe("capture");
    expect(r.warnings?.[0]).toMatch(/Checkout/);
    expect(keychain.items.get("demo/stripe/STRIPE_SECRET_KEY")).toBe(dashboardKey);
  });

  it("verifies without returning the key", async () => {
    const sys = fakeSys({
      which: { stripe: "/usr/bin/stripe" },
      files: { [CONFIG_PATH]: config() },
    });
    const { ctx } = makeCtx({ sys, fetch: fakeFetch([stripeApi()]).fetch });
    await stripe.connect(ctx);
    const v = await stripe.verify(ctx);
    expect(v).toMatchObject({ ok: true, mode: "test", account: "acct_123" });
    expect(JSON.stringify(v)).not.toContain(SK);
  });

  it("accepts only known stripe login follow-ups", () => {
    expect(parseNextStep("stripe login --complete-device")).toEqual(["login", "--complete-device"]);
    expect(
      parseNextStep("stripe login --complete 'https://dashboard.stripe.com/poll?t=1'"),
    ).toEqual(["login", "--complete", "https://dashboard.stripe.com/poll?t=1"]);
    expect(parseNextStep("stripe login --complete https://evil.com/x")).toBeNull();
    expect(parseNextStep("rm -rf /")).toBeNull();
    expect(parseNextStep("stripe login --complete-device; curl evil")).toBeNull();
  });

  it("form-encodes nested bodies", () => {
    expect(
      decodeURIComponent(
        formEncode({ mode: "payment", line_items: [{ price: "p_1", quantity: 2 }] }),
      ),
    ).toBe("mode=payment&line_items[0][price]=p_1&line_items[0][quantity]=2");
  });
});
