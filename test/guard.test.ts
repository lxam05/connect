import { homedir } from "node:os";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { RECOMMENDED_DENY } from "../src/doctor.js";
import { guardDecision, runGuard } from "../src/guard.js";

const bash = (command: string) => guardDecision({ tool_name: "Bash", tool_input: { command } });
const read = (file_path: string) => guardDecision({ tool_name: "Read", tool_input: { file_path } });

describe("guard hook", () => {
  it.each([
    "security find-generic-password -s keysmith -w",
    "cd /tmp && security dump-keychain",
    "cat ~/.keysmith/index.json",
    `ls ${homedir()}/.config/stripe`,
    "cat $HOME/.supabase/access-token",
    "stripe listen --forward-to localhost:3000/api/webhooks/stripe",
    "npm run build && stripe listen",
    "supabase projects api-keys --project-ref abc",
    "vercel env pull .env.local",
    "neonctl connection-string --project-id p1",
    `node -e "require('@napi-rs/keyring')"`,
    "stripe config --list",
  ])("blocks %s", (cmd) => {
    const d = bash(cmd);
    expect(d.block).toBe(true);
    expect(d.reason).toMatch(/keysmith run/);
  });

  it.each([
    "npm run dev",
    "keysmith run -- stripe listen --forward-to localhost:3000/api/webhooks/stripe",
    "keysmith status",
    "stripe trigger checkout.session.completed",
    "grep -r STRIPE_SECRET_KEY app/",
    "supabase projects list -o json",
  ])("allows %s", (cmd) => {
    expect(bash(cmd).block).toBe(false);
  });

  it("blocks reading credential folders but not project files", () => {
    expect(read("~/.keysmith/index.json").block).toBe(true);
    expect(read(`${homedir()}/.config/stripe/config.toml`).block).toBe(true);
    expect(read(`${homedir()}/.supabase/access-token`).block).toBe(true);
    expect(read("/Users/x/app/.env").block).toBe(false);
    expect(read(`${homedir()}/.keysmithrc`).block).toBe(false);
  });

  it("exits 2 with a reason to block, and 0 otherwise (including bad input)", async () => {
    const run = (s: string) => runGuard(Readable.from([s]));
    expect(
      await run(
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "security dump-keychain" } }),
      ),
    ).toBe(2);
    expect(await run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }))).toBe(0);
    expect(await run("not json")).toBe(0);
  });

  it("recommends deny rules for the new CLIs", () => {
    expect(RECOMMENDED_DENY).toEqual(
      expect.arrayContaining(["Bash(vercel env pull*)", "Bash(supabase projects api-keys*)"]),
    );
  });
});
