import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
const cliCommands = [
  ...readFileSync(join(root, "src/cli.ts"), "utf8").matchAll(/\.command\("(\w+)"\)/g),
].map((m) => m[1]);

describe("Claude Code plugin", () => {
  it("runs commands the CLI actually has", () => {
    const mcp = readJson("plugin/.mcp.json").mcpServers.keysmith;
    expect(mcp).toEqual({ command: "keysmith", args: ["mcp"] });
    const hook = readJson("plugin/hooks/hooks.json").hooks.PreToolUse[0];
    expect(hook.matcher).toMatch(/Bash/);
    expect(hook.hooks[0].command).toBe("keysmith guard");
    expect(cliCommands).toEqual(
      expect.arrayContaining(["mcp", "guard", "doctor", "setup", "scan"]),
    );
  });

  it("is listed by the marketplace with matching names and versions", () => {
    const plugin = readJson("plugin/.claude-plugin/plugin.json");
    const market = readJson(".claude-plugin/marketplace.json");
    const pkg = readJson("package.json");
    expect(market.plugins[0]).toMatchObject({
      name: plugin.name,
      source: "./plugin",
      version: plugin.version,
    });
    expect(plugin.version).toBe(pkg.version);
  });

  it("/keysmith uses the setup tool and never asks for keys in chat", () => {
    const command = readFileSync(join(root, "plugin/commands/keysmith.md"), "utf8");
    expect(command).toMatch(/^---\ndescription: /);
    expect(command).toMatch(/`setup` tool/);
    expect(command).toMatch(/Never ask the user to paste a key/);
  });
});
