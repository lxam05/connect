import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resend } from "../src/recipes/resend.js";
import { FakeCapture, type Route, fakeFetch, fakeSys, json, makeCtx } from "./fakes.js";

const ADMIN = "re_AdminFullAccessKey_1234567890";
const SEND1 = "re_SendingKeyNumberOne_123456789";
const SEND2 = "re_SendingKeyNumberTwo_123456789";

function resendApi() {
  const keys = new Map<string, string>([["admin-id", ADMIN]]); // id -> token
  const next = [
    { id: "k1", token: SEND1 },
    { id: "k2", token: SEND2 },
  ];
  const deleted: string[] = [];
  const bearer = (h: Headers) => h.get("authorization")?.replace("Bearer ", "") ?? "";
  const route: Route = ({ method, url, headers, body }) => {
    if (url.host !== "api.resend.com") return undefined;
    const key = bearer(headers);
    const valid = [...keys.values()].includes(key);
    if (!valid) return json({ name: "validation_error", message: "API key is invalid" }, 401);
    const isAdmin = key === ADMIN;
    if (!isAdmin)
      return json(
        { name: "restricted_api_key", message: "This API key is restricted to only send emails" },
        401,
      );
    if (url.pathname === "/api-keys" && method === "GET")
      return json({ data: [...keys.keys()].map((id) => ({ id })) });
    if (url.pathname === "/api-keys" && method === "POST") {
      expect(JSON.parse(body)).toMatchObject({ permission: "sending_access" });
      const k = next.shift()!;
      keys.set(k.id, k.token);
      return json(k, 201);
    }
    if (url.pathname.startsWith("/api-keys/") && method === "DELETE") {
      const id = url.pathname.split("/").pop()!;
      deleted.push(id);
      keys.delete(id);
      return json({}, 200);
    }
    if (url.pathname === "/domains")
      return json({ data: [{ name: "example.com", status: "verified" }] });
    return undefined;
  };
  return { route, deleted, keys };
}

describe("resend recipe", () => {
  it("captures a full-access key, derives a sending key, writes only placeholders", async () => {
    const api = resendApi();
    const sys = fakeSys();
    const capture = new FakeCapture([ADMIN]);
    const { ctx, root, keychain } = makeCtx({ capture, sys, fetch: fakeFetch([api.route]).fetch });

    const r = await resend.connect(ctx);
    expect(r.outcome).toBe("connected");
    expect(r.envVars).toEqual(["RESEND_API_KEY"]);
    expect(sys.opened).toEqual([]); // url is opened by the real capture, fake records it
    expect(capture.requests[0]!.url).toBe("https://resend.com/api-keys");

    const env = readFileSync(join(root, ".env"), "utf8");
    expect(env).toContain("RESEND_API_KEY=keysmith://demo/resend/RESEND_API_KEY");
    expect(env).not.toContain("RESEND_ADMIN_KEY");
    expect(env).not.toMatch(/re_[A-Z]/);
    expect(keychain.items.get("demo/resend/RESEND_API_KEY")).toBe(SEND1);
    expect(keychain.items.get("demo/resend/RESEND_ADMIN_KEY")).toBe(ADMIN);
    expect(JSON.stringify(r)).not.toContain("re_");
  });

  it("is idempotent", async () => {
    const api = resendApi();
    const capture = new FakeCapture([ADMIN]);
    const { ctx, root } = makeCtx({ capture, fetch: fakeFetch([api.route]).fetch });
    await resend.connect(ctx);
    const before = readFileSync(join(root, ".env"), "utf8");
    const again = await resend.connect(ctx);
    expect(again.outcome).toBe("already_connected");
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(before);
    expect(capture.requests).toHaveLength(1);
  });

  it("rejects a sending-only key as the bootstrap key", async () => {
    const api = resendApi();
    api.keys.set("other", SEND2);
    const { ctx } = makeCtx({
      capture: new FakeCapture([SEND2]),
      fetch: fakeFetch([api.route]).fetch,
    });
    const r = await resend.connect(ctx);
    expect(r.outcome).toBe("failed");
    expect(r.message).toMatch(/Full access/);
  });

  it("reuses a key saved by the Resend CLI", async () => {
    const api = resendApi();
    const sys = fakeSys({
      files: {
        "/home/test/.config/resend/credentials.json": JSON.stringify({
          default: { api_key: ADMIN },
        }),
      },
    });
    const capture = new FakeCapture([]);
    const { ctx, vault } = makeCtx({ capture, sys, fetch: fakeFetch([api.route]).fetch });
    const r = await resend.connect(ctx);
    expect(r.outcome).toBe("connected");
    expect(r.tier).toBe("cli");
    expect(capture.requests).toHaveLength(0);
    expect(vault.meta("keysmith://demo/resend/RESEND_ADMIN_KEY")?.tier).toBe("cli");
  });

  it("verifies and rotates: new key verified before the old one is deleted", async () => {
    const api = resendApi();
    const { ctx, keychain } = makeCtx({
      capture: new FakeCapture([ADMIN]),
      fetch: fakeFetch([api.route]).fetch,
    });
    await resend.connect(ctx);
    expect((await resend.verify(ctx)).ok).toBe(true);

    const r = await resend.rotate!(ctx);
    expect(r.outcome).toBe("connected");
    expect(keychain.items.get("demo/resend/RESEND_API_KEY")).toBe(SEND2);
    expect(api.deleted).toEqual(["k1"]);
    expect((await resend.verify(ctx)).ok).toBe(true);
  });

  it("repairs .env when the vault already has the keys", async () => {
    const api = resendApi();
    const { ctx, root } = makeCtx({
      capture: new FakeCapture([ADMIN]),
      fetch: fakeFetch([api.route]).fetch,
    });
    await resend.connect(ctx);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, ".env"), "OTHER=1\n");
    const r = await resend.connect(ctx);
    expect(r.outcome).toBe("repaired");
    expect(readFileSync(join(root, ".env"), "utf8")).toContain("RESEND_API_KEY=keysmith://");
  });
});
