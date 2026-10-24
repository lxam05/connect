import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { proxyRequest } from "../src/proxy/request.js";
import { getRecipe, ownerOf } from "../src/recipes/registry.js";
import { FakeCapture, type Route, fakeFetch, json, makeCtx } from "./fakes.js";

const OPENAI = "sk-proj-FakeOpenAIKeyABCDEFGHIJKLMNOP";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ab";

const openaiApi: Route = ({ url, headers }) => {
  if (url.host !== "api.openai.com") return undefined;
  if (headers.get("authorization") !== `Bearer ${OPENAI}`)
    return json({ error: { message: "Incorrect API key provided" } }, 401);
  return json({ data: [] });
};

const cloudflareApi =
  (accounts: { id: string; name: string }[]): Route =>
  ({ url, headers }) => {
    if (url.host !== "api.cloudflare.com") return undefined;
    if (headers.get("authorization") !== `Bearer ${TOKEN}`) return json({ success: false }, 401);
    if (url.pathname === "/client/v4/user/tokens/verify") return json({ success: true });
    if (url.pathname === "/client/v4/accounts") return json({ result: accounts });
    return undefined;
  };

describe("catalog (guided paste) recipes", () => {
  it("connects OpenAI from a pasted key and writes a placeholder", async () => {
    const capture = new FakeCapture([OPENAI]);
    const { ctx, root, keychain } = makeCtx({ capture, fetch: fakeFetch([openaiApi]).fetch });
    const r = await getRecipe("openai").connect(ctx);
    expect(r).toMatchObject({ outcome: "connected", mode: "live", tier: "capture" });
    expect(capture.requests[0]!.url).toBe("https://platform.openai.com/api-keys");
    expect(keychain.items.get("demo/openai/OPENAI_API_KEY")).toBe(OPENAI);
    const env = readFileSync(join(root, ".env"), "utf8");
    expect(env).toContain("OPENAI_API_KEY=keysmith://demo/openai/OPENAI_API_KEY");
    expect(env + JSON.stringify(r)).not.toContain(OPENAI);
    expect((await getRecipe("openai").connect(ctx)).outcome).toBe("already_connected");
  });

  it("saves nothing when the provider rejects the key", async () => {
    const capture = new FakeCapture(["sk-proj-WrongKeyABCDEFGHIJKLMNOPQRS"]);
    const { ctx, keychain } = makeCtx({ capture, fetch: fakeFetch([openaiApi]).fetch });
    const r = await getRecipe("openai").connect(ctx);
    expect(r.outcome).toBe("failed");
    expect(r.message).toMatch(/Nothing was saved/);
    expect(keychain.items.size).toBe(0);
  });

  it("rejects a value with the wrong shape in the dialog", async () => {
    const capture = new FakeCapture(["nope"]);
    const { ctx } = makeCtx({ capture, fetch: fakeFetch([openaiApi]).fetch });
    const r = await getRecipe("anthropic").connect(ctx);
    expect(r.outcome).toBe("failed");
  });

  it("moves a plain-text key from .env into the Keychain without asking", async () => {
    const capture = new FakeCapture([]);
    const { ctx, root, keychain } = makeCtx({ capture, fetch: fakeFetch([openaiApi]).fetch });
    writeFileSync(join(root, ".env"), `OPENAI_API_KEY=${OPENAI}\n`);
    const r = await getRecipe("openai").connect(ctx);
    expect(r).toMatchObject({ outcome: "connected", tier: "imported" });
    expect(capture.requests).toHaveLength(0);
    expect(keychain.items.get("demo/openai/OPENAI_API_KEY")).toBe(OPENAI);
    expect(readFileSync(join(root, ".env"), "utf8")).not.toContain(OPENAI);
  });

  it("verifies and proxies with the stored key, redacting it", async () => {
    const capture = new FakeCapture([OPENAI]);
    const { ctx } = makeCtx({ capture, fetch: fakeFetch([openaiApi]).fetch });
    await getRecipe("openai").connect(ctx);
    expect((await getRecipe("openai").verify(ctx)).ok).toBe(true);
    const res = await proxyRequest(ctx, "openai", "GET", "/v1/models");
    expect(res.status).toBe(200);
    await expect(
      proxyRequest(ctx, "openai", "GET", "/v1/organization/admin_api_keys"),
    ).rejects.toThrow(/manages keys/);
  });

  it("uses each provider's auth style", async () => {
    const seen: Record<string, string | null>[] = [];
    const record: Route = ({ url, headers }) => {
      seen.push({
        host: url.host,
        authorization: headers.get("authorization"),
        "x-api-key": headers.get("x-api-key"),
        "anthropic-version": headers.get("anthropic-version"),
      });
      return json({});
    };
    const anthropicKey = "sk-ant-api03-FakeKeyABCDEFGHIJKLMNOP";
    const sid = "AC0123456789abcdef0123456789abcdef";
    const authToken = "0123456789abcdef0123456789abcdef";
    {
      const { ctx } = makeCtx({
        capture: new FakeCapture([anthropicKey]),
        fetch: fakeFetch([record]).fetch,
      });
      await getRecipe("anthropic").connect(ctx);
    }
    {
      const { ctx } = makeCtx({
        capture: new FakeCapture([sid, authToken]),
        fetch: fakeFetch([record]).fetch,
      });
      expect((await getRecipe("twilio").connect(ctx)).outcome).toBe("connected");
    }
    expect(seen[0]).toMatchObject({
      authorization: `Bearer ${anthropicKey}`,
      "x-api-key": null,
      "anthropic-version": "2023-06-01",
    });
    expect(seen[1]!.authorization).toBe(
      `Basic ${Buffer.from(`${sid}:${authToken}`).toString("base64")}`,
    );
  });

  it("fills in the Cloudflare account id from the token", async () => {
    const capture = new FakeCapture([TOKEN]);
    const fetch = fakeFetch([cloudflareApi([{ id: "acc1", name: "Uncle Tommy" }])]).fetch;
    const { ctx, root } = makeCtx({ capture, fetch });
    const r = await getRecipe("cloudflare").connect(ctx);
    expect(r).toMatchObject({ outcome: "connected", account: "acc1", accountName: "Uncle Tommy" });
    expect(readFileSync(join(root, ".env"), "utf8")).toContain("CLOUDFLARE_ACCOUNT_ID=acc1");
  });

  it("asks which Cloudflare account when there are several, then uses the choice", async () => {
    const fetch = fakeFetch([
      cloudflareApi([
        { id: "acc1", name: "One" },
        { id: "acc2", name: "Two" },
      ]),
    ]).fetch;
    const capture = new FakeCapture([TOKEN]);
    const { ctx, root } = makeCtx({ capture, fetch });
    const first = await getRecipe("cloudflare").connect(ctx);
    expect(first.outcome).toBe("action_required");
    expect(first.message).toMatch(/"Two" \(acc2\)/);

    ctx.options.project = "acc2";
    const second = await getRecipe("cloudflare").connect(ctx);
    expect(second).toMatchObject({ outcome: "connected", account: "acc2" });
    expect(capture.requests).toHaveLength(1); // the token wasn't asked for twice
    expect(readFileSync(join(root, ".env"), "utf8")).toContain("CLOUDFLARE_ACCOUNT_ID=acc2");
  });

  it("maps env vars to the recipe that owns them", () => {
    expect(ownerOf("STRIPE_SECRET_KEY")?.id).toBe("stripe");
    expect(ownerOf("OPENAI_API_KEY")?.id).toBe("openai");
    expect(ownerOf("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")?.id).toBe("clerk");
    expect(ownerOf("FOO_API_KEY")).toBeUndefined();
  });
});
