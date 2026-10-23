import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeRef, parseRef } from "../src/vault/index.js";
import { memoryVault } from "./helpers.js";

const ref = makeRef("myapp", "stripe", "STRIPE_SECRET_KEY");
const meta = { mode: "test" as const, tier: "cli" as const, expires: null };

describe("refs", () => {
  it("round-trips", () => {
    expect(ref).toBe("keysmith://myapp/stripe/STRIPE_SECRET_KEY");
    expect(parseRef(ref)).toEqual({
      project: "myapp",
      service: "stripe",
      envVar: "STRIPE_SECRET_KEY",
    });
  });
  it("rejects malformed refs", () => {
    expect(() => parseRef("keysmith://a/b")).toThrow();
    expect(() => parseRef("keysmith://a/b/lower")).toThrow();
    expect(() => parseRef("keysmith://../b/C")).not.toThrow(); // ".." is a valid slug chars-wise
    expect(() => parseRef("https://x/y/Z")).toThrow();
  });
});

describe("Vault", () => {
  it("stores values in the keychain and only metadata on disk", () => {
    const { vault, keychain, home } = memoryVault();
    vault.set(ref, "sk_test_supersecret", meta);
    expect(keychain.items.get("myapp/stripe/STRIPE_SECRET_KEY")).toBe("sk_test_supersecret");
    const index = readFileSync(join(home, "index.json"), "utf8");
    expect(index).not.toContain("supersecret");
    expect(statSync(join(home, "index.json")).mode & 0o777).toBe(0o600);
    expect(vault.has(ref)).toBe(true);
    expect(vault.resolve(ref)).toBe("sk_test_supersecret");
  });

  it("list returns metadata without values", () => {
    const { vault } = memoryVault();
    vault.set(ref, "sk_test_supersecret", meta);
    const list = vault.list({ project: "myapp" });
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("supersecret");
    expect(list[0]).toMatchObject({ service: "stripe", envVar: "STRIPE_SECRET_KEY", mode: "test" });
  });

  it("has() is false when the keychain item is missing", () => {
    const { vault, keychain } = memoryVault();
    vault.set(ref, "sk_test_supersecret", meta);
    keychain.items.clear();
    expect(vault.has(ref)).toBe(false);
  });

  it("deletes", () => {
    const { vault } = memoryVault();
    vault.set(ref, "sk_test_supersecret", meta);
    expect(vault.delete(ref)).toBe(true);
    expect(vault.has(ref)).toBe(false);
    expect(vault.list()).toEqual([]);
  });

  it("refuses empty values", () => {
    const { vault } = memoryVault();
    expect(() => vault.set(ref, "", meta)).toThrow();
  });
});
