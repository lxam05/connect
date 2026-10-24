import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { proxyRequest } from "../src/proxy/request.js";
import { getRecipe } from "../src/recipes/registry.js";
import { FakeCapture, type Route, fakeFetch, fakeSys, json, makeCtx } from "./fakes.js";

const CLI_TOKEN = "gho_FakeCliTokenABCDEFGHIJKLMNOPQRSTUV";
const PAT = "github_pat_FakeFineGrainedABCDEFGHIJKLMNOP";
const RAILWAY = "1b2c3d4e-0000-4000-8000-fakeprojtoken";

const githubApi =
  (scopes?: string): Route =>
  ({ url, headers }) => {
    if (url.host !== "api.github.com") return undefined;
    const auth = headers.get("authorization");
    if (auth !== `Bearer ${CLI_TOKEN}` && auth !== `Bearer ${PAT}`)
      return json({ message: "Bad credentials" }, 401);
    if (url.pathname === "/user")
      return json(
        { login: "octo", id: 42 },
        200,
        auth === `Bearer ${CLI_TOKEN}` && scopes !== undefined ? { "X-OAuth-Scopes": scopes } : {},
      );
    return json([]);
  };

const ghSys = (signedIn = true) =>
  fakeSys({
    which: { gh: "/usr/local/bin/gh" },
    exec: (cmd, args) =>
      cmd === "gh" && args.join(" ") === "auth token --hostname github.com" && signedIn
        ? { code: 0, stdout: `${CLI_TOKEN}\n`, stderr: "" }
        : { code: 1, stdout: "", stderr: "not logged in" },
  });

describe("GitHub", () => {
  it("with --tier cli, reuses the CLI token, records the user and warns about scopes", async () => {
    const sys = ghSys();
    const { ctx, root, keychain } = makeCtx({
      sys,
      fetch: fakeFetch([githubApi("gist, read:org, repo, workflow, delete_repo")]).fetch,
      options: { tier: "cli" },
    });
    const r = await getRecipe("github").connect(ctx);
    expect(r).toMatchObject({
      outcome: "connected",
      tier: "cli",
      mode: "live",
      account: "42",
      accountName: "octo",
    });
    expect(r.warnings?.join(" ")).toMatch(/delete_repo/);
    expect(r.warnings?.join(" ")).toMatch(/fine-grained/);
    expect(keychain.items.get("demo/github/GITHUB_TOKEN")).toBe(CLI_TOKEN);
    const env = readFileSync(join(root, ".env"), "utf8");
    expect(env).toContain("GITHUB_TOKEN=keysmith://demo/github/GITHUB_TOKEN");
    expect(env + JSON.stringify(r)).not.toContain(CLI_TOKEN);
    expect((await getRecipe("github").connect(ctx)).outcome).toBe("already_connected");
  });

  it("asks the user to sign in when the CLI isn't", async () => {
    const { ctx, keychain } = makeCtx({
      sys: ghSys(false),
      fetch: fakeFetch([githubApi()]).fetch,
      options: { tier: "cli" },
    });
    const r = await getRecipe("github").connect(ctx);
    expect(r.outcome).toBe("action_required");
    expect(r.humanSteps?.[0]).toMatch(/gh auth login/);
    expect(keychain.items.size).toBe(0);
  });

  it("takes a pasted fine-grained token without the CLI, with no scope warnings", async () => {
    const capture = new FakeCapture([PAT]);
    const { ctx, keychain } = makeCtx({ capture, fetch: fakeFetch([githubApi()]).fetch });
    const r = await getRecipe("github").connect(ctx);
    expect(r).toMatchObject({ outcome: "connected", tier: "capture", accountName: "octo" });
    expect(r.warnings).toBeUndefined();
    expect(capture.requests[0]!.url).toBe("https://github.com/settings/personal-access-tokens/new");
    expect(keychain.items.get("demo/github/GITHUB_TOKEN")).toBe(PAT);
  });

  it("pastes a fine-grained token by default, even when the CLI is signed in", async () => {
    const sys = ghSys();
    const capture = new FakeCapture([PAT]);
    const { ctx } = makeCtx({ sys, capture, fetch: fakeFetch([githubApi()]).fetch });
    expect((await getRecipe("github").connect(ctx)).tier).toBe("capture");
    expect(sys.calls).toHaveLength(0);
  });

  it("with --tier cli, asks before installing the CLI", async () => {
    const { ctx } = makeCtx({ options: { tier: "cli" } });
    const r = await getRecipe("github").connect(ctx);
    expect(r.outcome).toBe("action_required");
    expect(r.humanSteps?.[0]).toMatch(/brew install gh/);
  });

  it("rejects a value that isn't a GitHub token, and saves nothing on 401", async () => {
    {
      const { ctx } = makeCtx({ capture: new FakeCapture(["sk-not-github-at-all-123456"]) });
      expect((await getRecipe("github").connect(ctx)).outcome).toBe("failed");
    }
    const bad = "ghp_RevokedTokenABCDEFGHIJKLMNOPQRSTU";
    const { ctx, keychain } = makeCtx({
      capture: new FakeCapture([bad]),
      fetch: fakeFetch([githubApi()]).fetch,
    });
    const r = await getRecipe("github").connect(ctx);
    expect(r.outcome).toBe("failed");
    expect(r.message).toMatch(/Nothing was saved/);
    expect(r.message).not.toContain(bad);
    expect(keychain.items.size).toBe(0);
  });

  it("moves a plain-text token from .env into the Keychain", async () => {
    const { ctx, root, keychain } = makeCtx({ fetch: fakeFetch([githubApi()]).fetch });
    writeFileSync(join(root, ".env"), `GITHUB_TOKEN=${PAT}\n`);
    const r = await getRecipe("github").connect(ctx);
    expect(r).toMatchObject({ outcome: "connected", tier: "imported" });
    expect(keychain.items.get("demo/github/GITHUB_TOKEN")).toBe(PAT);
    expect(readFileSync(join(root, ".env"), "utf8")).not.toContain(PAT);
  });

  it("verifies, proxies reads only, and blocks key and secret endpoints", async () => {
    const { ctx } = makeCtx({
      capture: new FakeCapture([PAT]),
      fetch: fakeFetch([githubApi()]).fetch,
    });
    await getRecipe("github").connect(ctx);
    expect(await getRecipe("github").verify(ctx)).toMatchObject({ ok: true, accountName: "octo" });
    const res = await proxyRequest(ctx, "github", "GET", "/repos/octo/app/issues");
    expect(res.status).toBe(200);
    expect(JSON.stringify(res)).not.toContain(PAT);
    await expect(proxyRequest(ctx, "github", "POST", "/repos/octo/app/issues", {})).rejects.toThrow(
      /live-mode/,
    );
    for (const path of [
      "/authorizations",
      "/user/keys",
      "/user/gpg_keys",
      "/repos/octo/app/keys",
      "/repos/octo/app/actions/secrets",
      "/orgs/acme/actions/secrets/FOO",
      "/repos/octo/app/actions/runners/registration-token",
      "/orgs/acme/personal-access-tokens",
    ])
      await expect(proxyRequest(ctx, "github", "GET", path), path).rejects.toThrow(/manages keys/);
  });
});

const railwayApi: Route = ({ url, headers, body }) => {
  if (url.host !== "backboard.railway.com" || url.pathname !== "/graphql/v2") return undefined;
  if (!body.includes("projectToken")) return json({ errors: [{ message: "unexpected" }] });
  if (headers.get("project-access-token") !== RAILWAY)
    return json({ data: null, errors: [{ message: "Not Authorized" }] });
  return json({ data: { projectToken: { projectId: "proj_1", environmentId: "env_1" } } });
};

describe("Railway", () => {
  it("connects a pasted project token and records project and environment", async () => {
    const capture = new FakeCapture([RAILWAY]);
    const { fetch, log } = fakeFetch([railwayApi]);
    const { ctx, root, keychain } = makeCtx({ capture, fetch });
    const r = await getRecipe("railway").connect(ctx);
    expect(r).toMatchObject({
      outcome: "connected",
      tier: "capture",
      mode: "live",
      account: "proj_1",
      accountName: "environment env_1",
    });
    expect(log[0]).toMatchObject({ method: "POST", auth: null });
    expect(keychain.items.get("demo/railway/RAILWAY_TOKEN")).toBe(RAILWAY);
    const env = readFileSync(join(root, ".env"), "utf8");
    expect(env).toContain("RAILWAY_TOKEN=keysmith://demo/railway/RAILWAY_TOKEN");
    expect(env + JSON.stringify(r)).not.toContain(RAILWAY);
    expect(await getRecipe("railway").verify(ctx)).toMatchObject({ ok: true, account: "proj_1" });
  });

  it("saves nothing when Railway rejects the token (e.g. an account token)", async () => {
    const wrong = "9f9f9f9f-0000-4000-8000-accounttoken";
    const { ctx, keychain } = makeCtx({
      capture: new FakeCapture([wrong]),
      fetch: fakeFetch([railwayApi]).fetch,
    });
    const r = await getRecipe("railway").connect(ctx);
    expect(r.outcome).toBe("failed");
    expect(r.message).toMatch(/Not Authorized.*project token/);
    expect(r.message).not.toContain(wrong);
    expect(keychain.items.size).toBe(0);
  });

  it("has no proxy: agents use the CLI through keysmith run", async () => {
    const { ctx } = makeCtx({
      capture: new FakeCapture([RAILWAY]),
      fetch: fakeFetch([railwayApi]).fetch,
    });
    await getRecipe("railway").connect(ctx);
    await expect(proxyRequest(ctx, "railway", "POST", "/graphql/v2", {})).rejects.toThrow(
      /no API Keysmith can call/,
    );
  });
});
