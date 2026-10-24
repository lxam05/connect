import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createContext } from "../app.js";
import { type Method, proxyRequest } from "../proxy/request.js";
import type { ConnectOptions, RecipeContext } from "../recipes/types.js";
import * as svc from "../service.js";

export const INSTRUCTIONS = `Keysmith gives this project the API keys it needs (Stripe, Resend, Supabase, Neon, OpenAI, Anthropic, Clerk, and any other secret) without you ever seeing a secret.

Start with setup: it scans the project, moves plain-text secrets into the Keychain, imports Vercel env vars when linked, connects every needed service, routes the dev script through keysmith and verifies. Call it again after the user completes the humanSteps it returns. Use scan to look without changing anything.

Rules:
- Never try to read secret values: not from the Keychain, ~/.keysmith, ~/.config/stripe, ~/.config/resend, or by printing env vars. No tool here returns them, by design.
- In code, read keys from process.env as usual (e.g. process.env.STRIPE_SECRET_KEY). .env holds keysmith:// placeholders; real values are injected at runtime by \`keysmith run -- <cmd>\`. Suggest the user change their dev script to e.g. "dev": "keysmith run -- next dev".
- When connect returns outcome "action_required", tell the user exactly what humanSteps say (e.g. approve a pairing code in the browser, paste a key into a macOS dialog), wait for them, then call connect again.
- Never install software (e.g. the Stripe CLI) without asking the user first.
- rotate needs the user's explicit confirmation.
- Use request() to call a provider API without holding the key. Responses are redacted.
- Never ask the user to paste a key into .env, a file or this chat. For a service Keysmith has no recipe for, call add_secret: the user pastes into a hidden macOS dialog.
- Run webhook forwarders and other commands that print secrets through \`keysmith run -- <cmd>\` (e.g. \`keysmith run -- stripe listen --forward-to …\`), so their output is redacted.
- Before telling the user the work is done, check the account names Keysmith reports and point out any warning.`;

type Json = Record<string, unknown> | unknown[];

function result(data: Json, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], isError };
}

function errorResult(e: unknown) {
  return result({ error: e instanceof Error ? e.message : String(e) }, true);
}

export function buildServer(
  makeCtx: (options?: ConnectOptions) => RecipeContext = (options) => createContext({ options }),
) {
  const server = new McpServer(
    { name: "keysmith", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );
  const service = z.string().describe('Service id, e.g. "stripe" or "resend"');

  server.registerTool(
    "list_services",
    {
      description:
        "List services Keysmith can connect, their env vars, and which human steps each may need.",
      annotations: { readOnlyHint: true },
    },
    async () => result({ services: svc.listServices() }),
  );

  server.registerTool(
    "connect",
    {
      description:
        'Connect a service to this project: obtains test-mode keys, stores them in the macOS Keychain, writes placeholders to .env. Safe to call repeatedly. May return outcome "action_required" with humanSteps for the user.',
      inputSchema: {
        service,
        tier: z
          .enum(["auto", "cli", "capture"])
          .optional()
          .describe(
            '"capture" skips CLIs and asks the user to paste a key into a hidden macOS dialog',
          ),
        project: z
          .string()
          .optional()
          .describe("Provider project or account id, when connect returned a list to choose from"),
      },
    },
    async ({ service, tier, project }) => {
      try {
        return result({ ...(await svc.connect(makeCtx({ tier, project }), service)) });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "scan",
    {
      description:
        "Work out which API keys this project needs: services from dependencies and env var references, secrets with no recipe, plain-text secrets in env files. Names and states only. Changes nothing.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return result({ ...(await svc.scan(makeCtx())) });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "setup",
    {
      description:
        "Give the project every API key it needs, in one call: scan, move plain-text secrets into the Keychain, import Vercel env vars if linked, connect each needed service, change the dev script to `keysmith run -- …`, and verify. Returns per-service outcomes and the humanSteps still needed; call again after the user does them. Returns no values.",
      inputSchema: {
        devScript: z
          .boolean()
          .optional()
          .describe("Set false to leave package.json's dev script alone"),
      },
    },
    async ({ devScript }) => {
      try {
        return result({ ...(await svc.setup(makeCtx(), { devScript })) });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "add_secret",
    {
      description:
        "Store a secret for a service Keysmith has no recipe for. The user pastes it into a hidden macOS dialog; .env gets a keysmith:// placeholder. Use this instead of asking the user to paste a key anywhere else.",
      inputSchema: {
        name: z.string().describe("Env var name, e.g. FOO_API_KEY"),
        url: z
          .string()
          .url()
          .optional()
          .describe("Page to open first, where the user creates the key"),
      },
    },
    async ({ name, url }) => {
      try {
        return result({ ...(await svc.addSecret(makeCtx(), [name], { url })) });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "status",
    {
      description:
        "Show connected services for this project: mode, expiry warnings, missing env vars. No values.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return result({ ...(await svc.status(makeCtx())) });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "verify",
    {
      description:
        "Prove a connected service's key works (calls a harmless read endpoint). Returns no values.",
      inputSchema: { service },
      annotations: { readOnlyHint: true },
    },
    async ({ service }) => {
      try {
        return result({ ...(await svc.verify(makeCtx(), service)) });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "rotate",
    {
      description:
        "Replace a service's key and revoke the old one, where the service supports it. What rotate does differs per service: check the `rotation` field from list_services before describing it to the user. Requires the user's explicit confirmation: only pass confirm=true after the user has said yes in chat.",
      inputSchema: {
        service,
        confirm: z
          .boolean()
          .optional()
          .describe("Set true only after the user explicitly confirmed rotation"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ service, confirm }) => {
      try {
        let confirmed = confirm === true;
        if (!confirmed && server.server.getClientCapabilities()?.elicitation) {
          const answer = await server.server.elicitInput({
            mode: "form",
            message: `Rotate the ${service} key? A new key is created and the old one revoked; running apps must restart.`,
            requestedSchema: {
              type: "object",
              properties: { confirm: { type: "boolean", title: "Rotate now" } },
              required: ["confirm"],
            },
          });
          confirmed = answer.action === "accept" && answer.content?.confirm === true;
          if (!confirmed)
            return result({ service, outcome: "canceled", message: "The user declined rotation." });
        }
        if (!confirmed) {
          return result({
            service,
            outcome: "confirmation_required",
            message: `Ask the user to confirm rotating the ${service} key, then call rotate again with confirm: true.`,
          });
        }
        return result({ ...(await svc.rotate(makeCtx(), service)) });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "request",
    {
      description:
        "Call a connected provider's API without holding its key (auth is injected, response redacted). Allowed hosts only: api.stripe.com, api.resend.com. Paths that manage API keys are blocked. Stripe bodies are form-encoded automatically.",
      inputSchema: {
        service,
        method: z.enum(["GET", "POST", "DELETE", "PATCH", "PUT"]),
        path: z
          .string()
          .describe('API path incl. query, e.g. "/v1/customers?limit=3" or "/domains"'),
        body: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ service, method, path, body }) => {
      try {
        return result({
          ...(await proxyRequest(makeCtx(), service, method as Method, path, body)),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
