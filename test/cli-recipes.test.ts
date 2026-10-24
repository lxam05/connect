import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { neon } from "../src/recipes/neon.js";
import { supabase } from "../src/recipes/supabase.js";
import { type Route, fakeFetch, fakeSys, json, makeCtx } from "./fakes.js";

const SERVICE = "eyJhbGciOiJIUzI1NiJ9.service-role-fake.sig";
const ANON = "eyJhbGciOiJIUzI1NiJ9.anon-fake.sig";
const PROJECTS = [
  { id: "abcdefghijklmnopqrst", name: "shop-db" },
  { id: "zyxwvutsrqponmlkjihg", name: "other" },
];

function supabaseCli(opts: { loggedIn?: boolean; projects?: typeof PROJECTS } = {}) {
  return fakeSys({
    which: { supabase: "/opt/homebrew/bin/supabase" },
    exec: (_cmd, args) => {
      if (args[0] === "projects" && args[1] === "list")
        return opts.loggedIn === false
          ? { code: 1, stdout: "", stderr: "Access token not provided" }
          : { code: 0, stdout: JSON.stringify(opts.projects ?? PROJECTS.slice(0, 1)), stderr: "" };
      if (args[0] === "projects" && args[1] === "api-keys")
        return {
          code: 0,
          stdout: JSON.stringify([
            { name: "anon", api_key: ANON },
            { name: "service_role", api_key: SERVICE },
          ]),
          stderr: "",
        };
      return { code: 1, stdout: "", stderr: "" };
    },
  });
}

const supabaseApi: Route = ({ url, headers }) =>
  url.host.endsWith(".supabase.co")
    ? headers.get("apikey") === SERVICE
      ? json({})
      : json({ message: "Invalid API key" }, 401)
    : undefined;

describe("supabase recipe", () => {
  it("asks the user to sign in when the CLI isn't logged in", async () => {
    const { ctx } = makeCtx({ sys: supabaseCli({ loggedIn: false }) });
    const r = await supabase.connect(ctx);
    expect(r.outcome).toBe("action_required");
    expect(r.humanSteps?.[0]).toMatch(/supabase login/);
  });

  it("connects the only project with no pasting", async () => {
    const { ctx, root, keychain } = makeCtx({
      sys: supabaseCli(),
      fetch: fakeFetch([supabaseApi]).fetch,
    });
    const r = await supabase.connect(ctx);
    expect(r).toMatchObject({
      outcome: "connected",
      account: PROJECTS[0]!.id,
      accountName: "shop-db",
    });
    const env = readFileSync(join(root, ".env"), "utf8");
    expect(env).toContain(`NEXT_PUBLIC_SUPABASE_URL=https://${PROJECTS[0]!.id}.supabase.co`);
    expect(env).toContain(`NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON}`);
    expect(env).toContain(
      "SUPABASE_SERVICE_ROLE_KEY=keysmith://demo/supabase/SUPABASE_SERVICE_ROLE_KEY",
    );
    expect(keychain.items.get("demo/supabase/SUPABASE_SERVICE_ROLE_KEY")).toBe(SERVICE);
    expect(JSON.stringify(r)).not.toContain(SERVICE);
    expect((await supabase.verify(ctx)).ok).toBe(true);
  });

  it("asks which project when there are several, then uses the choice", async () => {
    const { ctx } = makeCtx({
      sys: supabaseCli({ projects: PROJECTS }),
      fetch: fakeFetch([supabaseApi]).fetch,
    });
    const first = await supabase.connect(ctx);
    expect(first.outcome).toBe("action_required");
    expect(first.message).toMatch(/"other"/);
    ctx.options.project = "other";
    expect(await supabase.connect(ctx)).toMatchObject({
      outcome: "connected",
      accountName: "other",
    });
  });
});

describe("supabase project status and wording", () => {
  it("says a paused project must be restored instead of failing vaguely", async () => {
    const paused = [{ ...PROJECTS[0]!, status: "INACTIVE" }];
    const { ctx } = makeCtx({ sys: supabaseCli({ projects: paused as typeof PROJECTS }) });
    const r = await supabase.connect(ctx);
    expect(r.outcome).toBe("action_required");
    expect(r.message).toMatch(/is paused/);
    expect(r.humanSteps?.[0]).toMatch(/Restore shop-db/);
  });

  it("tells a terminal user which command to run, and marks paused projects", async () => {
    const mixed = [
      { ...PROJECTS[0]!, status: "INACTIVE" },
      { ...PROJECTS[1]!, status: "ACTIVE_HEALTHY" },
    ];
    const { ctx } = makeCtx({
      sys: supabaseCli({ projects: mixed as typeof PROJECTS }),
      options: { wait: true },
    });
    const r = await supabase.connect(ctx);
    expect(r.message).toMatch(/keysmith connect supabase --project <id>/);
    expect(r.message).toMatch(/"shop-db" \(abcdefghijklmnopqrst\) \[paused\]/);
    expect(r.message).not.toMatch(/call connect/);
  });
});

describe("neon recipe", () => {
  const URL = "postgresql://app:pw123@ep-cool-1.eu-west-2.aws.neon.tech/neondb?sslmode=require";
  const cli = (loggedIn = true) =>
    fakeSys({
      which: { neonctl: "/usr/local/bin/neonctl" },
      exec: (_cmd, args) => {
        if (args[0] === "projects")
          return loggedIn
            ? {
                code: 0,
                stdout: JSON.stringify({ projects: [{ id: "p1", name: "shop" }] }),
                stderr: "",
              }
            : { code: 1, stdout: "", stderr: "auth" };
        if (args[0] === "connection-string") return { code: 0, stdout: `${URL}\n`, stderr: "" };
        return { code: 1, stdout: "", stderr: "" };
      },
    });

  it("stores DATABASE_URL from the CLI and verifies its shape", async () => {
    const { ctx, keychain } = makeCtx({ sys: cli() });
    const r = await neon.connect(ctx);
    expect(r).toMatchObject({ outcome: "connected", account: "p1" });
    expect(keychain.items.get("demo/neon/DATABASE_URL")).toBe(URL);
    expect(JSON.stringify(r)).not.toContain("pw123");
    const v = await neon.verify(ctx);
    expect(v.ok).toBe(true);
    expect(v.message).not.toContain("pw123");
  });

  it("asks for sign-in or install as needed", async () => {
    expect((await neon.connect(makeCtx({ sys: cli(false) }).ctx)).humanSteps?.[0]).toMatch(
      /neonctl auth/,
    );
    expect((await neon.connect(makeCtx({ sys: fakeSys() }).ctx)).humanSteps?.[0]).toMatch(
      /npm install -g neonctl/,
    );
  });
});
