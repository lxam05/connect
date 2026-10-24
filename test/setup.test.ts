import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupProject, updateDevScript } from "../src/setup.js";
import { FakeCapture, type Route, fakeFetch, fakeSys, json, makeCtx } from "./fakes.js";

const SK = "sk_test_51SetupStripeKeyABCDEFGHIJ";
const PK = "pk_test_51SetupPublishableABCDEFGH";
const OPENAI = "sk-proj-SetupOpenAIKeyABCDEFGHIJKLMN";
const FOO = "foo-plain-secret-123";

const apis: Route = ({ url }) => {
  if (url.host === "api.stripe.com") {
    if (url.pathname === "/v1/balance") return json({ livemode: false });
    if (url.pathname === "/v1/account")
      return json({ id: "acct_Setup1", settings: { dashboard: { display_name: "Setup Co" } } });
    return json({ data: [] });
  }
  if (url.host === "api.openai.com") return json({ data: [] });
  return undefined;
};

function write(root: string, path: string, content: string) {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

function project(capture: FakeCapture) {
  const made = makeCtx({ capture, sys: fakeSys(), fetch: fakeFetch([apis]).fetch });
  const { root } = made;
  write(
    root,
    "package.json",
    JSON.stringify(
      { name: "demo", scripts: { dev: "next dev" }, dependencies: { stripe: "23" } },
      null,
      2,
    ),
  );
  write(root, "lib/ai.ts", "process.env.OPENAI_API_KEY; process.env.BAR_TOKEN;\n");
  write(root, ".env", `FOO_API_KEY=${FOO}\n`);
  write(root, "lib/foo.ts", "process.env.FOO_API_KEY;\n");
  return made;
}

describe("setup", () => {
  it("gets every key the project needs, then is a no-op the second time", async () => {
    // Stripe (CLI missing, so it's pasted), OpenAI, then the BAR_TOKEN custom secret.
    const capture = new FakeCapture([SK, PK, OPENAI, "bar-value-456"]);
    const { ctx, root, keychain } = project(capture);
    ctx.options = { tier: "capture" };
    const r = await setupProject(ctx);

    expect(r.imported).toEqual(["FOO_API_KEY"]);
    expect(r.services.map((s) => [s.id, s.outcome])).toEqual([
      ["stripe", "connected"],
      ["openai", "connected"],
      ["custom", "connected"],
    ]);
    expect(r.services.every((s) => s.verified?.ok)).toBe(true);
    expect(r.services[0]).toMatchObject({ account: "acct_Setup1", accountName: "Setup Co" });
    expect(r.done).toBe(true);
    expect(r.devScript).toMatchObject({ changed: true, command: "keysmith run -- next dev" });
    expect(keychain.items.get("demo/custom/FOO_API_KEY")).toBe(FOO);
    expect(keychain.items.get("demo/custom/BAR_TOKEN")).toBe("bar-value-456");

    const env = readFileSync(join(root, ".env"), "utf8");
    for (const v of [SK, OPENAI, FOO, "bar-value-456"]) expect(env).not.toContain(v);
    expect(JSON.stringify(r)).not.toMatch(new RegExp([SK, OPENAI, FOO].join("|")));

    const again = await setupProject(ctx);
    expect(again.services.every((s) => s.outcome === "already_connected")).toBe(true);
    expect(again.devScript.changed).toBe(false);
    expect(capture.requests).toHaveLength(4);
  });

  it("returns human steps instead of finishing when something needs a person", async () => {
    const capture = new FakeCapture([]); // the user cancels every dialog
    const { ctx } = project(capture);
    ctx.options = { tier: "capture" };
    const r = await setupProject(ctx);
    expect(r.done).toBe(false);
    expect(r.humanSteps.length).toBeGreaterThan(0);
    expect(r.summary).toMatch(/run setup again/);
  });

  it("only rewrites the dev script once and keeps indentation", () => {
    const { root } = makeCtx({});
    write(root, "package.json", '{\n    "scripts": {\n        "dev": "vite"\n    }\n}\n');
    expect(updateDevScript(root)).toMatchObject({ changed: true, command: "keysmith run -- vite" });
    expect(readFileSync(join(root, "package.json"), "utf8")).toContain('        "dev"');
    expect(updateDevScript(root).changed).toBe(false);
  });
});
