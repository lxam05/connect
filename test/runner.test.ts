import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { REDACTED } from "../src/redact.js";
import { MissingSecretError, resolveProjectEnv, runWithSecrets } from "../src/runner.js";
import { makeRef } from "../src/vault/index.js";
import { memoryVault, tmp } from "./helpers.js";

const SECRET = "sk_test_51RunnerSecretValueXYZ0123456789";
const meta = { mode: "test" as const, tier: "cli" as const, expires: null };

function setup() {
  const root = tmp();
  const { vault } = memoryVault();
  const ref = makeRef("app", "stripe", "STRIPE_SECRET_KEY");
  vault.set(ref, SECRET, meta);
  writeFileSync(join(root, ".env"), `STRIPE_SECRET_KEY=${ref}\nPLAIN=hello\n`);
  return { project: { root, name: "app" }, vault };
}

function collect() {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (c) => chunks.push(String(c)));
  return { stream, text: () => chunks.join("") };
}

describe("resolveProjectEnv", () => {
  it("resolves placeholders and keeps plain values", () => {
    const { project, vault } = setup();
    const { env, secretKeys, redactor } = resolveProjectEnv(project, vault);
    expect(env).toEqual({ STRIPE_SECRET_KEY: SECRET, PLAIN: "hello" });
    expect([...secretKeys]).toEqual(["STRIPE_SECRET_KEY"]);
    expect(redactor.size).toBe(1);
  });

  it("errors with the service name (not a value) when a secret is missing", () => {
    const { project } = setup();
    const { vault: empty } = memoryVault();
    expect(() => resolveProjectEnv(project, empty)).toThrow(MissingSecretError);
    expect(() => resolveProjectEnv(project, empty)).toThrow(/keysmith connect stripe/);
  });
});

describe("runWithSecrets", () => {
  it("injects the real value and redacts it from output", async () => {
    const { project, vault } = setup();
    const out = collect();
    const err = collect();
    const script = `
      const s = process.env.STRIPE_SECRET_KEY;
      process.stdout.write("len=" + s.length + "\\n");
      process.stdout.write("value=" + s + "\\n");
      process.stdout.write(s.slice(0, 12)); setTimeout(() => { process.stdout.write(s.slice(12) + "|\\n");
      console.error("err:" + s); console.log("plain=" + process.env.PLAIN); }, 30);
    `;
    const code = await runWithSecrets({
      project,
      vault,
      command: process.execPath,
      args: ["-e", script],
      stdout: out.stream,
      stderr: err.stream,
    });
    expect(code).toBe(0);
    expect(out.text()).toContain(`len=${SECRET.length}`);
    expect(out.text()).toContain(`value=${REDACTED}`);
    expect(out.text()).toContain(`${REDACTED}|`);
    expect(out.text()).toContain("plain=hello");
    expect(out.text()).not.toContain(SECRET.slice(10, 30));
    expect(err.text()).toBe(`err:${REDACTED}\n`);
  });

  it("propagates the exit code", async () => {
    const { project, vault } = setup();
    const code = await runWithSecrets({
      project,
      vault,
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      stdout: collect().stream,
      stderr: collect().stream,
    });
    expect(code).toBe(3);
  });
});
