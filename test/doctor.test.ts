import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RECOMMENDED_DENY, addDenyRules, runDoctor } from "../src/doctor.js";
import { MemoryKeychain } from "../src/vault/keychain.js";
import { fakeSys } from "./fakes.js";
import { tmp } from "./helpers.js";

const settings = (root: string) => join(root, ".claude", "settings.json");
interface Settings {
  model?: string;
  permissions: { allow?: string[]; deny: string[] };
}
const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Settings;

describe("doctor deny rules", () => {
  it("creates .claude/settings.json with the rules", () => {
    const root = tmp();
    expect(addDenyRules(settings(root), RECOMMENDED_DENY)).toBe(true);
    expect(read(settings(root)).permissions.deny).toEqual(RECOMMENDED_DENY);
  });

  it("merges into existing settings without dropping anything", () => {
    const root = tmp();
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      settings(root),
      JSON.stringify({
        model: "x",
        permissions: { allow: ["Bash(ls)"], deny: ["Read(./secret)", RECOMMENDED_DENY[0]] },
      }),
    );
    addDenyRules(settings(root), RECOMMENDED_DENY);
    const json = read(settings(root));
    expect(json.model).toBe("x");
    expect(json.permissions.allow).toEqual(["Bash(ls)"]);
    expect(json.permissions.deny).toEqual(["Read(./secret)", ...RECOMMENDED_DENY]);
  });

  it("leaves invalid JSON alone", () => {
    const root = tmp();
    mkdirSync(join(root, ".claude"));
    writeFileSync(settings(root), "{ not json");
    expect(addDenyRules(settings(root), RECOMMENDED_DENY)).toBe(false);
    expect(readFileSync(settings(root), "utf8")).toBe("{ not json");
  });

  it("doctor --fix adds the rules and explains why when they're missing", async () => {
    const root = tmp();
    const project = { root, name: "demo" };
    const before = await runDoctor(project, fakeSys(), new MemoryKeychain());
    const check = before.find((c) => c.name === "Claude Code deny rules")!;
    if (!check.ok) expect(check.detail).toMatch(/stop your agent reading keys/);

    const after = await runDoctor(project, fakeSys(), new MemoryKeychain(), { fix: true });
    expect(after.find((c) => c.name === "Claude Code deny rules")!.ok).toBe(true);
    expect(read(settings(root)).permissions.deny).toEqual(
      expect.arrayContaining(["Bash(stripe listen*)"]),
    );
  });
});
