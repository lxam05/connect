import { describe, expect, it } from "vitest";
import { proxyRequest } from "../src/proxy/request.js";
import { REDACTED } from "../src/redact.js";
import { fakeFetch, json, makeCtx } from "./fakes.js";

const SK = "sk_test_51ProxySecretKeyABCDEFGHIJ";

function connected(route = () => json({ ok: true })) {
  const f = fakeFetch([route]);
  const made = makeCtx({ fetch: f.fetch });
  made.vault.set("keysmith://demo/stripe/STRIPE_SECRET_KEY", SK, {
    mode: "test",
    tier: "cli",
    expires: null,
  });
  return { ...made, log: f.log };
}

describe("proxyRequest", () => {
  it("injects auth and redacts secrets from the response", async () => {
    const { ctx, log } = connected(() =>
      json({
        id: "cs_1",
        client_secret: "cs_secret_xyz",
        echoed: `key was ${SK}`,
        other: "rk_test_ABCDEFGHIJKLMNOP",
      }),
    );
    const r = await proxyRequest(ctx, "stripe", "POST", "/v1/checkout/sessions", {
      mode: "payment",
    });
    expect(r.ok).toBe(true);
    expect(r.body).toEqual({
      id: "cs_1",
      client_secret: REDACTED,
      echoed: `key was ${REDACTED}`,
      other: REDACTED,
    });
    expect(log[0]!.auth).toMatch(/^Basic /);
    expect(log[0]!.body).toBe("mode=payment");
    expect(log[0]!.url).toBe("https://api.stripe.com/v1/checkout/sessions");
  });

  it("refuses other hosts and protocol-relative paths", async () => {
    const { ctx } = connected();
    await expect(proxyRequest(ctx, "stripe", "GET", "//evil.com/x")).rejects.toThrow(/single/);
    await expect(proxyRequest(ctx, "stripe", "GET", "https://evil.com/x")).rejects.toThrow();
  });

  it("blocks key-management endpoints", async () => {
    const { ctx } = connected();
    ctx.vault.set("keysmith://demo/resend/RESEND_API_KEY", "re_SendKeyABCDEFGHIJKLMNOP", {
      mode: "test",
      tier: "derived",
      expires: null,
    });
    await expect(proxyRequest(ctx, "resend", "POST", "/api-keys", {})).rejects.toThrow(
      /manages keys/,
    );
  });

  it("blocks mutating calls on live keys", async () => {
    const { ctx } = connected();
    ctx.vault.set("keysmith://demo/stripe/STRIPE_SECRET_KEY", SK, {
      mode: "live",
      tier: "cli",
      expires: null,
    });
    await expect(proxyRequest(ctx, "stripe", "POST", "/v1/customers", {})).rejects.toThrow(
      /live-mode/,
    );
    await expect(proxyRequest(ctx, "stripe", "GET", "/v1/customers")).resolves.toMatchObject({
      ok: true,
    });
  });

  it("errors when not connected", async () => {
    const { ctx } = makeCtx({});
    await expect(proxyRequest(ctx, "stripe", "GET", "/v1/balance")).rejects.toThrow(
      /not connected/,
    );
  });
});
