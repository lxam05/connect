import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { proxyRequest } from "../src/proxy/request.js";
import { CATALOG, isVerified } from "../src/recipes/catalog.js";
import { getRecipe, recipes } from "../src/recipes/registry.js";
import { listServices } from "../src/service.js";
import { siteCatalog } from "../src/site-catalog.js";
import { describeSetupService } from "../src/setup.js";
import { FakeCapture, type Route, fakeFetch, json, makeCtx } from "./fakes.js";

const GROQ = "gsk_FakeGroqKeyABCDEFGHIJKLMNOPQRSTUV";
const UPSTASH_URL = "https://fake-db-12345.upstash.io";
const UPSTASH_TOKEN = "AXyzFakeUpstashTokenABCDEFGHIJKLMNOP";

const groqApi: Route = ({ url, headers }) => {
  if (url.host !== "api.groq.com") return undefined;
  if (headers.get("authorization") !== `Bearer ${GROQ}`)
    return json({ error: { message: "Invalid API Key" } }, 401);
  if (url.pathname === "/openai/v1/models") return json({ data: [] });
  return undefined;
};

describe("catalog rules", () => {
  it("gives every recipe a support level", () => {
    for (const r of recipes) expect(r.support, r.id).toBeTruthy();
    expect(getRecipe("stripe").support).toBe("dedicated");
    expect(getRecipe("openai").support).toBe("verified-paste");
    expect(getRecipe("upstash-redis").support).toBe("catalog-only");
    expect(getRecipe("custom").support).toBe("custom");
    expect(listServices().find((s) => s.id === "groq")?.support).toBe("verified-paste");
  });

  it("keeps ids unique and catalog-only entries well formed", () => {
    const ids = recipes.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of CATALOG) {
      expect(
        e.envVars.some((v) => v.secret),
        e.id,
      ).toBe(true);
      if (isVerified(e)) continue;
      expect(e.unverifiable.length, e.id).toBeGreaterThan(10);
      // Derived values need an API call, which a catalog-only entry can't make.
      expect(
        e.envVars.some((v) => v.derived),
        e.id,
      ).toBe(false);
      expect(getRecipe(e.id).hosts).toEqual([]);
    }
  });
});

describe("verified paste tracer (Groq)", () => {
  it("connects, verifies and proxies without leaking the key", async () => {
    const capture = new FakeCapture([GROQ]);
    const { ctx, root, keychain } = makeCtx({ capture, fetch: fakeFetch([groqApi]).fetch });
    const r = await getRecipe("groq").connect(ctx);
    expect(r).toMatchObject({ outcome: "connected", tier: "capture" });
    expect(capture.requests[0]!.url).toBe("https://console.groq.com/keys");
    expect(keychain.items.get("demo/groq/GROQ_API_KEY")).toBe(GROQ);
    const env = readFileSync(join(root, ".env"), "utf8");
    expect(env).toContain("GROQ_API_KEY=keysmith://demo/groq/GROQ_API_KEY");

    const v = await getRecipe("groq").verify(ctx);
    expect(v).toMatchObject({ ok: true });
    expect(v.unverified).toBeUndefined();
    const res = await proxyRequest(ctx, "groq", "GET", "/openai/v1/models");
    expect(res.status).toBe(200);
    expect(env + JSON.stringify([r, v, res])).not.toContain(GROQ);
  });

  it("saves nothing when Groq rejects the key", async () => {
    const capture = new FakeCapture(["gsk_WrongKeyABCDEFGHIJKLMNOPQRSTUVW"]);
    const { ctx, keychain } = makeCtx({ capture, fetch: fakeFetch([groqApi]).fetch });
    const r = await getRecipe("groq").connect(ctx);
    expect(r.outcome).toBe("failed");
    expect(r.message).toMatch(/Nothing was saved/);
    expect(r.message).not.toContain("gsk_");
    expect(keychain.items.size).toBe(0);
  });
});

describe("catalog-only tracer (Upstash Redis)", () => {
  it("stores the token, never calls the network, and never claims it works", async () => {
    const capture = new FakeCapture([UPSTASH_URL, UPSTASH_TOKEN]);
    const { fetch, log } = fakeFetch([]);
    const { ctx, root, keychain } = makeCtx({ capture, fetch });
    const r = await getRecipe("upstash-redis").connect(ctx);
    expect(r.outcome).toBe("connected");
    expect(r.message).toMatch(/not verified/);
    expect(keychain.items.get("demo/upstash-redis/UPSTASH_REDIS_REST_TOKEN")).toBe(UPSTASH_TOKEN);
    const env = readFileSync(join(root, ".env"), "utf8");
    expect(env).toContain(`UPSTASH_REDIS_REST_URL=${UPSTASH_URL}`); // public identifier
    expect(env).toContain(
      "UPSTASH_REDIS_REST_TOKEN=keysmith://demo/upstash-redis/UPSTASH_REDIS_REST_TOKEN",
    );

    const v = await getRecipe("upstash-redis").verify(ctx);
    expect(v).toMatchObject({ ok: true, unverified: true });
    expect(v.message).toMatch(/not verified/);
    expect((await getRecipe("upstash-redis").detect(ctx)).modeLabel).toBe("stored, not verified");
    expect(log).toHaveLength(0);
    expect(env + JSON.stringify([r, v])).not.toContain(UPSTASH_TOKEN);
  });

  it("refuses to proxy, since there's no fixed host", async () => {
    const capture = new FakeCapture([UPSTASH_URL, UPSTASH_TOKEN]);
    const { ctx } = makeCtx({ capture, fetch: fakeFetch([]).fetch });
    await getRecipe("upstash-redis").connect(ctx);
    await expect(proxyRequest(ctx, "upstash-redis", "GET", "/get/foo")).rejects.toThrow(
      /no API Keysmith can call/,
    );
  });

  it("shows as stored, not verified, in setup output", () => {
    const line = describeSetupService({
      id: "upstash-redis",
      displayName: "Upstash Redis",
      outcome: "connected",
      message: "",
      verified: { ok: true, message: "", unverified: true },
    });
    expect(line).toBe("· Upstash Redis: stored, not verified");
  });
});

describe("site catalog", () => {
  it("matches the recipes (run `npm run build` after changing a recipe)", () => {
    const committed = JSON.parse(readFileSync(join(__dirname, "../site/catalog.json"), "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(siteCatalog())));
  });

  it("holds public metadata only", () => {
    const text = JSON.stringify(siteCatalog());
    for (const e of CATALOG) {
      expect(e.docsUrl, e.id).toMatch(/^https:\/\//);
      for (const v of e.envVars) expect(text).not.toMatch(new RegExp(`${v.name}=`));
    }
    expect(text).not.toMatch(/blockedPaths|keysmith:\/\//);
  });
});
