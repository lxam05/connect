import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/mcp/server.js";
import { makeCtx } from "./fakes.js";

async function connectClient(capabilities = {}) {
  const { ctx, vault } = makeCtx({});
  const server = buildServer(() => ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" }, { capabilities });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, vault };
}

const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

describe("MCP server", () => {
  it("exposes exactly the metadata-only tools, with instructions", async () => {
    const { client } = await connectClient();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["connect", "list_services", "request", "rotate", "status", "verify"]);
    expect(client.getInstructions()).toMatch(/Never try to read secret values/);
  });

  it("status never includes values", async () => {
    const { client, vault } = await connectClient();
    vault.set("keysmith://demo/stripe/STRIPE_SECRET_KEY", "sk_test_51NeverShowMeABCDEFGHIJ", {
      mode: "test",
      tier: "cli",
      expires: null,
    });
    const r = await client.callTool({ name: "status", arguments: {} });
    expect(JSON.stringify(r)).not.toContain("NeverShowMe");
    expect(text(r).services.find((s: { service: string }) => s.service === "stripe").state).toBe(
      "incomplete",
    );
  });

  it("rotate requires confirmation when the client can't elicit", async () => {
    const { client } = await connectClient();
    const r = await client.callTool({ name: "rotate", arguments: { service: "resend" } });
    expect(text(r).outcome).toBe("confirmation_required");
  });

  it("returns tool errors for unknown services", async () => {
    const { client } = await connectClient();
    const r = await client.callTool({ name: "verify", arguments: { service: "nope" } });
    expect(r.isError).toBe(true);
    expect(text(r).error).toMatch(/Unknown service/);
  });
});
