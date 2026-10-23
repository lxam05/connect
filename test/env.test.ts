import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProject, slugify } from "../src/context.js";
import { ensureGitignore, parseEnv, upsertEnvContent, writeProjectEnv } from "../src/env/index.js";
import { tmp } from "./helpers.js";

describe("parseEnv", () => {
  it("parses common dotenv syntax", () => {
    const env = parseEnv(`# comment\nA=1\nexport B="two words"\nC='x#y'\nD=val # trailing\nE=\n`);
    expect(Object.fromEntries(env)).toEqual({ A: "1", B: "two words", C: "x#y", D: "val", E: "" });
  });
});

describe("upsertEnvContent", () => {
  const entries = [{ key: "STRIPE_SECRET_KEY", value: "keysmith://app/stripe/STRIPE_SECRET_KEY" }];

  it("appends new keys under a header and keeps other lines", () => {
    const { content, changed } = upsertEnvContent(
      "# mine\nFOO=bar\n",
      entries,
      "# stripe (keysmith)",
    );
    expect(changed).toBe(true);
    expect(content).toBe(
      "# mine\nFOO=bar\n\n# stripe (keysmith)\nSTRIPE_SECRET_KEY=keysmith://app/stripe/STRIPE_SECRET_KEY\n",
    );
  });

  it("replaces an existing value in place", () => {
    const { content } = upsertEnvContent("A=1\nSTRIPE_SECRET_KEY=sk_test_old\nB=2\n", entries);
    expect(content).toBe("A=1\nSTRIPE_SECRET_KEY=keysmith://app/stripe/STRIPE_SECRET_KEY\nB=2\n");
  });

  it("is idempotent", () => {
    const first = upsertEnvContent("", entries, "# h").content;
    const second = upsertEnvContent(first, entries, "# h");
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first);
  });
});

describe("ensureGitignore", () => {
  it("adds .env when missing", () => {
    const root = tmp();
    writeFileSync(join(root, ".gitignore"), "node_modules");
    expect(ensureGitignore(root)).toBe(true);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toMatch(/^\.env$/m);
    expect(ensureGitignore(root)).toBe(false);
  });

  it("un-ignores .env.example under a .env* wildcard (Next.js default)", () => {
    const root = tmp();
    writeFileSync(join(root, ".gitignore"), ".env*\n");
    expect(ensureGitignore(root)).toBe(true);
    const gi = readFileSync(join(root, ".gitignore"), "utf8");
    expect(gi).toContain("!.env.example");
    expect(gi.match(/^\.env$/m)).toBeNull();
  });
});

describe("writeProjectEnv", () => {
  it("writes placeholders, public values, and a blanked example", () => {
    const root = tmp();
    const res = writeProjectEnv(
      root,
      [
        { key: "S", value: "keysmith://app/svc/S", secret: true },
        { key: "P", value: "pk_test_public", secret: false },
      ],
      "# svc",
    );
    expect(res).toEqual({ envChanged: true, exampleChanged: true, gitignoreChanged: true });
    expect(readFileSync(join(root, ".env"), "utf8")).toContain("P=pk_test_public");
    const example = readFileSync(join(root, ".env.example"), "utf8");
    expect(example).toContain("S=keysmith://app/svc/S");
    expect(example).toMatch(/^P=$/m);
  });
});

describe("project context", () => {
  it("uses package.json name, slugified", () => {
    const root = tmp();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@acme/Web App" }));
    expect(resolveProject(root)).toEqual({ root, name: "acme-web-app" });
  });
  it("falls back to folder name", () => {
    expect(slugify("My Folder")).toBe("my-folder");
  });
});
