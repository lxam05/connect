import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DialogCapture, prefixValidator } from "../src/capture/index.js";
import { describeMode, inferMode } from "../src/recipes/common.js";
import { custom } from "../src/recipes/custom.js";
import { resend } from "../src/recipes/resend.js";
import { runWithSecrets } from "../src/runner.js";
import { listServices } from "../src/service.js";
import { fakeSys } from "./fakes.js";
import { memoryVault, tmp } from "./helpers.js";

describe("foundations", () => {
  it("labels Resend as sending access instead of test mode", () => {
    expect(describeMode(resend, "test")).toBe("sending access");
    expect(describeMode({}, "test")).toBe("test mode");
    expect(describeMode(custom, "test")).toBe("stored, not verified");
  });

  it("infers live or test from key prefixes", () => {
    expect(inferMode("sk_live_abc")).toBe("live");
    expect(inferMode("rk_test_abc")).toBe("test");
    expect(inferMode("whatever")).toBe("test");
  });

  it("lists what rotate does for each service", () => {
    const byId = Object.fromEntries(listServices().map((s) => [s.id, s]));
    expect(byId.stripe!.rotation).toMatch(/rolled there/);
    expect(byId.resend!.rotation).toMatch(/sending-only key/);
  });

  it("warns when keysmith run finds no placeholders", async () => {
    const { vault } = memoryVault();
    const err = new PassThrough();
    const chunks: string[] = [];
    err.on("data", (c) => chunks.push(String(c)));
    const code = await runWithSecrets({
      project: { root: tmp(), name: "empty" },
      vault,
      command: process.execPath,
      args: ["-e", ""],
      stdout: new PassThrough(),
      stderr: err,
    });
    expect(code).toBe(0);
    expect(chunks.join("")).toMatch(/no keysmith:\/\/ placeholders/);
  });

  it("re-asks with the problem, then says nothing was saved", async () => {
    const seen: string[] = [];
    const dialog = async (message: string) => {
      seen.push(message);
      return { canceled: false, value: "sk_test_nope" };
    };
    const capture = new DialogCapture(fakeSys(), dialog, "darwin");
    const r = await capture.capture({
      title: "t",
      message: "Paste a key",
      validate: prefixValidator(["sk_test_"], "a key"),
    });
    expect(seen).toHaveLength(3);
    expect(seen[1]).toMatch(/too short/);
    expect(r).toMatchObject({ ok: false, reason: "invalid" });
    expect(!r.ok && r.message).toMatch(/Nothing was saved/);
  });

  it("reports a cancel as nothing saved", async () => {
    const capture = new DialogCapture(
      fakeSys(),
      async () => ({ canceled: true, value: "" }),
      "darwin",
    );
    const r = await capture.capture({ title: "t", message: "m", validate: () => null });
    expect(!r.ok && r.message).toMatch(/Nothing was saved/);
  });
});
