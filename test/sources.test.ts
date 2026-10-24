import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importDotenv, plaintextSecrets } from "../src/sources/dotenv.js";
import { looksSecret } from "../src/sources/import.js";
import { importVercel } from "../src/sources/vercel.js";
import { fakeSys, makeCtx } from "./fakes.js";

const SK = "sk_test_51PlainStripeKeyABCDEFGHIJ";
const FOO = "foo-secret-value-xyz";

const vercelTemps = () => readdirSync(tmpdir()).filter((f) => f.startsWith("keysmith-vercel-"));

describe("looksSecret", () => {
  it("uses the owning recipe first, then names and value shapes", () => {
    expect(looksSecret("STRIPE_SECRET_KEY")).toBe(true);
    expect(looksSecret("STRIPE_PUBLISHABLE_KEY")).toBe(false);
    expect(looksSecret("FOO_API_KEY")).toBe(true);
    expect(looksSecret("DATABASE_URL")).toBe(true);
    expect(looksSecret("NEXT_PUBLIC_SITE_KEY")).toBe(false);
    expect(looksSecret("SOMETHING", "sk-live-ish")).toBe(true);
    expect(looksSecret("PORT", "3000")).toBe(false);
  });
});

describe("dotenv import", () => {
  it("moves plain secrets into the Keychain under their owner, leaving public values", () => {
    const { ctx, root, keychain } = makeCtx({});
    writeFileSync(
      join(root, ".env"),
      `STRIPE_SECRET_KEY=${SK}\nSTRIPE_PUBLISHABLE_KEY=pk_test_abc\nPORT=3000\n`,
    );
    writeFileSync(join(root, ".env.local"), `FOO_API_KEY=${FOO}\nOTHER=1\n`);
    expect(plaintextSecrets(ctx)).toEqual(["FOO_API_KEY", "STRIPE_SECRET_KEY"]);

    const r = importDotenv(ctx);
    expect(r.imported.sort()).toEqual(["FOO_API_KEY", "STRIPE_SECRET_KEY"]);
    expect(keychain.items.get("demo/stripe/STRIPE_SECRET_KEY")).toBe(SK);
    expect(keychain.items.get("demo/custom/FOO_API_KEY")).toBe(FOO);
    const env = readFileSync(join(root, ".env"), "utf8");
    expect(env).toContain("STRIPE_SECRET_KEY=keysmith://demo/stripe/STRIPE_SECRET_KEY");
    expect(env).toContain("FOO_API_KEY=keysmith://demo/custom/FOO_API_KEY");
    expect(env).toContain("STRIPE_PUBLISHABLE_KEY=pk_test_abc");
    const local = readFileSync(join(root, ".env.local"), "utf8");
    expect(local).not.toContain(FOO);
    expect(local).toContain("OTHER=1");
    expect(JSON.stringify(r)).not.toMatch(new RegExp(`${SK}|${FOO}`));
    expect(plaintextSecrets(ctx)).toEqual([]);
  });

  it("leaves vars Keysmith already manages alone", () => {
    const { ctx, root, vault } = makeCtx({});
    vault.set("keysmith://demo/stripe/STRIPE_SECRET_KEY", "sk_test_51StoredKeyABCDEFGHIJKL", {
      mode: "test",
      tier: "cli",
      expires: null,
    });
    writeFileSync(join(root, ".env.local"), `STRIPE_SECRET_KEY=${SK}\n`);
    expect(importDotenv(ctx).skipped).toEqual(["STRIPE_SECRET_KEY"]);
  });
});

describe("vercel import", () => {
  function linked(exec: (args: string[]) => { code: number; stdout: string; stderr: string }) {
    const sys = fakeSys({ which: { vercel: "/usr/local/bin/vercel" }, exec: (_c, a) => exec(a) });
    const made = makeCtx({ sys });
    mkdirSync(join(made.root, ".vercel"));
    writeFileSync(join(made.root, ".vercel", "project.json"), "{}");
    return made;
  }

  it("pulls into a temp file, imports, and deletes the file", async () => {
    const before = vercelTemps().length;
    let pulledTo = "";
    const { ctx, root, keychain } = linked((args) => {
      pulledTo = args[2]!;
      writeFileSync(
        pulledTo,
        `OPENAI_API_KEY="sk-proj-VercelKeyABCDEFGHIJKLMNOP"\nNEXT_PUBLIC_SITE_URL=https://x.dev\nVERCEL_OIDC_TOKEN=eyJabc\n`,
      );
      return { code: 0, stdout: "", stderr: "" };
    });
    const r = await importVercel(ctx);
    expect(r).toMatchObject({ imported: ["OPENAI_API_KEY"], public: ["NEXT_PUBLIC_SITE_URL"] });
    expect(keychain.items.get("demo/openai/OPENAI_API_KEY")).toMatch(/^sk-proj-/);
    expect(keychain.items.has("demo/custom/VERCEL_OIDC_TOKEN")).toBe(false);
    expect(readFileSync(join(root, ".env"), "utf8")).toContain(
      "NEXT_PUBLIC_SITE_URL=https://x.dev",
    );
    expect(existsSync(pulledTo)).toBe(false);
    expect(vercelTemps().length).toBe(before);
  });

  it("deletes the temp file when the pull fails, and asks for login", async () => {
    const before = vercelTemps().length;
    const { ctx } = linked(() => ({ code: 1, stdout: "", stderr: "not logged in" }));
    const r = await importVercel(ctx);
    expect(r).toMatchObject({ error: expect.stringMatching(/vercel env pull/) });
    expect(vercelTemps().length).toBe(before);
  });

  it("does nothing for folders that aren't linked", async () => {
    const { ctx } = makeCtx({ sys: fakeSys({ which: { vercel: "/x" } }) });
    expect(await importVercel(ctx)).toMatchObject({ error: expect.stringMatching(/isn't linked/) });
  });
});
