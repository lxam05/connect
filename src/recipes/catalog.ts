/**
 * Services connected by a guided paste: open the provider's key page, take the key in a
 * hidden dialog, verify it against a harmless read endpoint when the provider has one.
 * Data only; see paste.ts. How to add an entry: docs/provider-expansion.md.
 */

export interface CatalogVar {
  name: string;
  secret: boolean;
  description: string;
  /** Accepted key prefixes, e.g. ["sk-ant-"]. */
  prefixes?: string[];
  /** Accepted shape when there's no prefix, e.g. a UUID. */
  pattern?: RegExp;
  /** Filled in by the recipe after the secrets verify, instead of asking the user. */
  derived?: boolean;
}

export type CatalogAuth =
  | { type: "bearer"; secret: string }
  | { type: "header"; name: string; secret: string; extra?: Record<string, string> }
  | { type: "basic"; user: string; secret: string };

interface BaseEntry {
  id: string;
  displayName: string;
  packages: string[];
  envVars: CatalogVar[];
  /** Where the user creates the key. */
  keyPage: string;
  /** Official page confirming the env var names (and the verify endpoint, when there is one). */
  docsUrl?: string;
}

/** A key Keysmith checks against a documented, free, read-only endpoint. */
export interface VerifiedEntry extends BaseEntry {
  /** API host the proxy may call. */
  host: string;
  auth: CatalogAuth;
  /** Harmless read used to verify. `{VAR}` is replaced with that var's (public) value. */
  verifyPath: string;
  /** Paths that manage keys or the account; never proxied. */
  blockedPaths: RegExp[];
}

/** A key Keysmith stores and redacts but can't check. Never reported as verified. */
export interface CatalogOnlyEntry extends BaseEntry {
  /** Why Keysmith can't verify the key, in one sentence for people. */
  unverifiable: string;
}

export type CatalogEntry = VerifiedEntry | CatalogOnlyEntry;

export function isVerified(entry: CatalogEntry): entry is VerifiedEntry {
  return "verifyPath" in entry;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CATALOG: CatalogEntry[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    packages: ["openai", "@ai-sdk/openai"],
    envVars: [
      { name: "OPENAI_API_KEY", secret: true, prefixes: ["sk-"], description: "OpenAI API key" },
    ],
    keyPage: "https://platform.openai.com/api-keys",
    host: "api.openai.com",
    auth: { type: "bearer", secret: "OPENAI_API_KEY" },
    verifyPath: "/v1/models",
    blockedPaths: [/^\/v1\/organization\b/],
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    packages: ["@anthropic-ai/sdk", "@ai-sdk/anthropic"],
    envVars: [
      {
        name: "ANTHROPIC_API_KEY",
        secret: true,
        prefixes: ["sk-ant-"],
        description: "Anthropic API key",
      },
    ],
    keyPage: "https://console.anthropic.com/settings/keys",
    host: "api.anthropic.com",
    auth: {
      type: "header",
      name: "x-api-key",
      secret: "ANTHROPIC_API_KEY",
      extra: { "anthropic-version": "2023-06-01" },
    },
    verifyPath: "/v1/models",
    blockedPaths: [/^\/v1\/organizations\b/],
  },
  {
    id: "clerk",
    displayName: "Clerk",
    packages: ["@clerk/nextjs", "@clerk/backend", "@clerk/clerk-react", "@clerk/express"],
    envVars: [
      {
        name: "CLERK_SECRET_KEY",
        secret: true,
        prefixes: ["sk_test_", "sk_live_"],
        description: "Clerk secret key",
      },
      {
        name: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
        secret: false,
        prefixes: ["pk_test_", "pk_live_"],
        description: "Clerk publishable key (public)",
      },
    ],
    keyPage: "https://dashboard.clerk.com/last-active?path=api-keys",
    host: "api.clerk.com",
    auth: { type: "bearer", secret: "CLERK_SECRET_KEY" },
    verifyPath: "/v1/users?limit=1",
    blockedPaths: [/^\/v1\/(instance|api_keys)\b/],
  },
  {
    id: "sendgrid",
    displayName: "SendGrid",
    packages: ["@sendgrid/mail", "@sendgrid/client"],
    envVars: [
      { name: "SENDGRID_API_KEY", secret: true, prefixes: ["SG."], description: "SendGrid key" },
    ],
    keyPage: "https://app.sendgrid.com/settings/api_keys",
    host: "api.sendgrid.com",
    auth: { type: "bearer", secret: "SENDGRID_API_KEY" },
    verifyPath: "/v3/scopes",
    blockedPaths: [/^\/v3\/api_keys\b/],
  },
  {
    id: "twilio",
    displayName: "Twilio",
    packages: ["twilio"],
    envVars: [
      {
        name: "TWILIO_ACCOUNT_SID",
        secret: false,
        prefixes: ["AC"],
        description: "Twilio Account SID (identifier)",
      },
      {
        name: "TWILIO_AUTH_TOKEN",
        secret: true,
        pattern: /^[0-9a-f]{32}$/i,
        description: "Twilio auth token",
      },
    ],
    keyPage: "https://console.twilio.com/",
    host: "api.twilio.com",
    auth: { type: "basic", user: "TWILIO_ACCOUNT_SID", secret: "TWILIO_AUTH_TOKEN" },
    verifyPath: "/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}.json",
    blockedPaths: [/\/(Keys|SigningKeys)\b/],
  },
  {
    id: "postmark",
    displayName: "Postmark",
    packages: ["postmark"],
    envVars: [
      {
        name: "POSTMARK_SERVER_TOKEN",
        secret: true,
        pattern: UUID,
        description: "Postmark server API token",
      },
    ],
    keyPage: "https://account.postmarkapp.com/servers",
    host: "api.postmarkapp.com",
    auth: { type: "header", name: "X-Postmark-Server-Token", secret: "POSTMARK_SERVER_TOKEN" },
    verifyPath: "/server",
    blockedPaths: [],
  },
  {
    id: "cloudflare",
    displayName: "Cloudflare",
    packages: ["cloudflare"],
    envVars: [
      {
        name: "CLOUDFLARE_API_TOKEN",
        secret: true,
        pattern: /^[A-Za-z0-9_-]{40}$/,
        description: "Cloudflare API token",
      },
      {
        name: "CLOUDFLARE_ACCOUNT_ID",
        secret: false,
        derived: true,
        description: "Cloudflare account id (filled in from the token)",
      },
    ],
    keyPage: "https://dash.cloudflare.com/profile/api-tokens",
    host: "api.cloudflare.com",
    auth: { type: "bearer", secret: "CLOUDFLARE_API_TOKEN" },
    verifyPath: "/client/v4/user/tokens/verify",
    blockedPaths: [/^\/client\/v4\/(user|accounts\/[^/]+)\/tokens\b/],
  },
  {
    id: "groq",
    displayName: "Groq",
    packages: ["groq-sdk", "@ai-sdk/groq"],
    envVars: [{ name: "GROQ_API_KEY", secret: true, description: "Groq API key" }],
    keyPage: "https://console.groq.com/keys",
    docsUrl: "https://console.groq.com/docs/models",
    host: "api.groq.com",
    auth: { type: "bearer", secret: "GROQ_API_KEY" },
    verifyPath: "/openai/v1/models",
    blockedPaths: [],
  },
  {
    id: "upstash-redis",
    displayName: "Upstash Redis",
    packages: ["@upstash/redis"],
    envVars: [
      { name: "UPSTASH_REDIS_REST_URL", secret: false, description: "REST URL (identifier)" },
      { name: "UPSTASH_REDIS_REST_TOKEN", secret: true, description: "REST token" },
    ],
    keyPage: "https://console.upstash.com/",
    docsUrl: "https://upstash.com/docs/redis/sdks/ts/getstarted",
    unverifiable: "Each database has its own REST host, which Keysmith can't verify against yet.",
  },
];
