import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { custom } from "../src/recipes/custom.js";
import { status } from "../src/service.js";
import { proxyRequest } from "../src/proxy/request.js";
import { FakeCapture, makeCtx } from "./fakes.js";

describe("custom secrets", () => {
  it("stores any named secret from the dialog and lists it in status", async () => {
    const capture = new FakeCapture(["xyz-secret-value-123"]);
    const { ctx, root, keychain } = makeCtx({ capture, options: { vars: ["FOO_API_KEY"] } });
    const r = await custom.connect(ctx);
    expect(r).toMatchObject({ outcome: "connected", envVars: ["FOO_API_KEY"] });
    expect(keychain.items.get("demo/custom/FOO_API_KEY")).toBe("xyz-secret-value-123");
    expect(readFileSync(join(root, ".env"), "utf8")).toContain(
      "FOO_API_KEY=keysmith://demo/custom/FOO_API_KEY",
    );

    ctx.options.vars = undefined;
    const st = await status(ctx);
    expect(st.services.find((s) => s.service === "custom")).toMatchObject({ state: "connected" });
    expect((await custom.verify(ctx)).ok).toBe(true);
    expect(JSON.stringify([r, st])).not.toContain("xyz-secret-value-123");
  });

  it("moves a plain value from .env instead of asking", async () => {
    const capture = new FakeCapture([]);
    const { ctx, root } = makeCtx({ capture, options: { vars: ["FOO_TOKEN"] } });
    writeFileSync(join(root, ".env"), "FOO_TOKEN=plain-value-123\n");
    const r = await custom.connect(ctx);
    expect(r.message).toMatch(/Moved FOO_TOKEN/);
    expect(capture.requests).toHaveLength(0);
    expect(readFileSync(join(root, ".env"), "utf8")).not.toContain("plain-value-123");
  });

  it("is idempotent and rejects bad names", async () => {
    const { ctx } = makeCtx({
      capture: new FakeCapture(["v1-value"]),
      options: { vars: ["A_KEY"] },
    });
    await custom.connect(ctx);
    expect((await custom.connect(ctx)).outcome).toBe("already_connected");
    ctx.options.vars = ["not-valid"];
    expect((await custom.connect(ctx)).outcome).toBe("failed");
  });

  it("can't be proxied", async () => {
    const { ctx } = makeCtx({});
    await expect(proxyRequest(ctx, "custom", "GET", "/")).rejects.toThrow(/no API/);
  });
});
