import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { proxyRequest } from "../src/proxy/request.js";
import { CATALOG, type VerifiedEntry, isVerified } from "../src/recipes/catalog.js";
import { getRecipe } from "../src/recipes/registry.js";
import { FakeCapture, type Route, fakeFetch, json, makeCtx } from "./fakes.js";

const VERIFIED = [
  "mistral",
  "deepseek",
  "cohere",
  "cerebras",
  "replicate",
  "elevenlabs",
  "gemini",
  "pinecone",
  "deepgram",
  "assemblyai",
];
const CATALOG_ONLY = ["xai", "together"];

const keyFor = (id: string) => `fake-${id}-key-ABCDEFGHIJKLMNOP0123`;

/** The headers each provider's docs say to send, written out by hand. */
const EXPECTED: Record<string, Record<string, string>> = {
  mistral: { authorization: `Bearer ${keyFor("mistral")}` },
  deepseek: { authorization: `Bearer ${keyFor("deepseek")}` },
  cohere: { authorization: `Bearer ${keyFor("cohere")}` },
  cerebras: { authorization: `Bearer ${keyFor("cerebras")}` },
  replicate: { authorization: `Bearer ${keyFor("replicate")}` },
  elevenlabs: { "xi-api-key": keyFor("elevenlabs") },
  gemini: { "x-goog-api-key": keyFor("gemini") },
  pinecone: { "api-key": keyFor("pinecone"), "x-pinecone-api-version": "2026-07" },
  deepgram: { authorization: `Token ${keyFor("deepgram")}` },
  assemblyai: { authorization: keyFor("assemblyai") },
};

const entry = (id: string) => CATALOG.find((e) => e.id === id)!;

/** Accepts only the documented host, path and headers for the provider's own key. */
const providerApi =
  (e: VerifiedEntry): Route =>
  ({ url, headers }) => {
    if (url.host !== e.host) return undefined;
    const ok = Object.entries(EXPECTED[e.id]!).every(([k, v]) => headers.get(k) === v);
    if (!ok) return json({ error: "unauthorized" }, 401);
    return url.pathname + url.search === e.verifyPath ? json({ data: [] }) : json({}, 200);
  };

describe("AI providers (verified paste)", () => {
  it.each(VERIFIED)("%s connects with the documented auth and verify call", async (id) => {
    const e = entry(id);
    expect(isVerified(e)).toBe(true);
    if (!isVerified(e)) return;
    const capture = new FakeCapture([keyFor(id)]);
    const { fetch, log } = fakeFetch([providerApi(e)]);
    const { ctx, root, keychain } = makeCtx({ capture, fetch });
    const r = await getRecipe(id).connect(ctx);
    expect(r.outcome).toBe("connected");
    expect(log[0]!.url).toBe(`https://${e.host}${e.verifyPath}`);
    expect(capture.requests[0]!.url).toBe(e.keyPage);
    const name = e.envVars[0]!.name;
    expect(keychain.items.get(`demo/${id}/${name}`)).toBe(keyFor(id));
    const env = readFileSync(join(root, ".env"), "utf8");
    expect(env).toContain(`${name}=keysmith://demo/${id}/${name}`);
    expect(env + JSON.stringify(r)).not.toContain(keyFor(id));
    expect((await getRecipe(id).verify(ctx)).ok).toBe(true);
    const res = await proxyRequest(ctx, id, "GET", e.verifyPath);
    expect(JSON.stringify(res)).not.toContain(keyFor(id));
  });

  it.each(VERIFIED)("%s saves nothing when the key is rejected", async (id) => {
    const e = entry(id) as VerifiedEntry;
    const wrong = `wrong-${id}-key-ABCDEFGHIJKLMNOP`;
    const { ctx, keychain } = makeCtx({
      capture: new FakeCapture([wrong]),
      fetch: fakeFetch([providerApi(e)]).fetch,
    });
    const r = await getRecipe(id).connect(ctx);
    expect(r.outcome).toBe("failed");
    expect(r.message).not.toContain(wrong);
    expect(keychain.items.size).toBe(0);
  });

  it("blocks key-management paths", async () => {
    const cases: [string, string][] = [
      ["elevenlabs", "/v1/service-accounts/sa_1/api-keys"],
      ["pinecone", "/admin/api-keys"],
      ["deepgram", "/v1/projects/p1/keys"],
    ];
    for (const [id, path] of cases) {
      const e = entry(id) as VerifiedEntry;
      const { ctx } = makeCtx({
        capture: new FakeCapture([keyFor(id)]),
        fetch: fakeFetch([providerApi(e)]).fetch,
      });
      await getRecipe(id).connect(ctx);
      await expect(proxyRequest(ctx, id, "GET", path), path).rejects.toThrow(/manages keys/);
    }
  });
});

describe("AI providers (catalog only)", () => {
  it.each(CATALOG_ONLY)("%s is stored, never called, and never claimed valid", async (id) => {
    const { fetch, log } = fakeFetch([]);
    const { ctx } = makeCtx({ capture: new FakeCapture([keyFor(id)]), fetch });
    expect((await getRecipe(id).connect(ctx)).outcome).toBe("connected");
    expect(await getRecipe(id).verify(ctx)).toMatchObject({ ok: true, unverified: true });
    expect(log).toHaveLength(0);
  });
});
