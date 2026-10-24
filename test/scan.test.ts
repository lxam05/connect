import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCAN_LIMITS, scanProject } from "../src/scan.js";
import { makeCtx } from "./fakes.js";

function write(root: string, path: string, content: string) {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

function nextApp() {
  const made = makeCtx({});
  const { root } = made;
  write(
    root,
    "package.json",
    JSON.stringify({
      name: "demo",
      scripts: { dev: "next dev" },
      dependencies: { next: "16", stripe: "23", resend: "6" },
    }),
  );
  write(root, "lib/ai.ts", "export const key = process.env.OPENAI_API_KEY;\n");
  write(
    root,
    "lib/foo.ts",
    'const k = process.env["FOO_API_KEY"]; const u = process.env.NEXT_PUBLIC_SITE_URL;\n',
  );
  write(root, "app/hook.ts", "process.env.STRIPE_WEBHOOK_SECRET;\n");
  write(root, "node_modules/x/index.js", "process.env.IGNORED_SECRET_KEY;\n");
  write(root, ".env.example", "BAR_TOKEN=\n");
  write(root, ".env", "FOO_API_KEY=plain-value-123\n");
  return made;
}

describe("scan", () => {
  it("finds services from dependencies, code and .env.example", async () => {
    const { ctx } = nextApp();
    const r = await scanProject(ctx);
    const ids = r.services.map((s) => s.id);
    expect(ids).toEqual(["stripe", "stripe-webhook", "resend", "openai"]);
    const stripe = r.services.find((s) => s.id === "stripe")!;
    expect(stripe).toMatchObject({ kind: "dedicated", state: "not_connected" });
    expect(stripe.reasons).toContain("dependency stripe");
    expect(r.services.find((s) => s.id === "openai")!.reasons).toEqual([
      "process.env.OPENAI_API_KEY in lib/ai.ts",
    ]);
  });

  it("lists secret-looking vars with no recipe, and ignores public and skipped ones", async () => {
    const { ctx } = nextApp();
    const r = await scanProject(ctx);
    expect(r.unmatched.map((u) => u.name)).toEqual(["BAR_TOKEN", "FOO_API_KEY"]);
    expect(JSON.stringify(r)).not.toMatch(/NEXT_PUBLIC_SITE_URL|IGNORED_SECRET_KEY/);
  });

  it("flags plain-text secrets, the dev script and Vercel links without values", async () => {
    const { ctx, root } = nextApp();
    write(root, ".vercel/project.json", "{}");
    const r = await scanProject(ctx);
    expect(r.plaintext).toEqual(["FOO_API_KEY"]);
    expect(r.devScript).toEqual({ present: true, usesKeysmith: false });
    expect(r.vercel).toBe(true);
    expect(JSON.stringify(r)).not.toContain("plain-value-123");
  });

  it("stops walking at the file limit", async () => {
    const { ctx, root } = makeCtx({});
    const saved = SCAN_LIMITS.files;
    SCAN_LIMITS.files = 3;
    try {
      for (let i = 0; i < 5; i++) write(root, `src/f${i}.ts`, "process.env.X_KEY;\n");
      expect((await scanProject(ctx)).truncated).toBe(true);
    } finally {
      SCAN_LIMITS.files = saved;
    }
  });
});
