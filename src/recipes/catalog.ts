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
  | { type: "bearer"; secret: string; extra?: Record<string, string> }
  | {
      type: "header";
      name: string;
      secret: string;
      /** Put before the value, e.g. "Token " for `Authorization: Token <key>`. */
      prefix?: string;
      extra?: Record<string, string>;
    }
  | { type: "basic"; user: string; secret: string };

interface BaseEntry {
  id: string;
  displayName: string;
  packages: string[];
  envVars: CatalogVar[];
  /** Where the user creates the key. */
  keyPage: string;
  /** Official page confirming the env var names (and the verify endpoint, when there is one). */
  docsUrl: string;
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
    docsUrl: "https://developers.openai.com/api/reference/resources/models/methods/list",
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
    keyPage: "https://platform.claude.com/settings/keys",
    docsUrl: "https://platform.claude.com/docs/en/api/overview#authentication",
    host: "api.anthropic.com",
    auth: {
      type: "bearer",
      secret: "ANTHROPIC_API_KEY",
      // Still a documented version. Newer ones remove request parameters (e.g. temperature),
      // which would break calls agents make through request().
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
    docsUrl: "https://github.com/clerk/openapi-specs/blob/main/bapi/2026-08-20.yml",
    host: "api.clerk.com",
    auth: { type: "bearer", secret: "CLERK_SECRET_KEY" },
    verifyPath: "/v1/users?limit=1",
    // Endpoints that manage the instance or mint, return or rotate secrets and tokens.
    blockedPaths: [
      /^\/v1\/(instance|api_keys|actor_tokens|sign_in_tokens|testing_tokens|m2m_tokens|admin_portal_link_tokens|oauth_applications|machines)\b/,
      /^\/v1\/sessions\/[^/]+\/tokens\b/,
      /^\/v1\/users\/[^/]+\/oauth_access_tokens\b/,
      /\/rotate_api_key$/,
    ],
  },
  {
    id: "sendgrid",
    displayName: "SendGrid",
    packages: ["@sendgrid/mail", "@sendgrid/client"],
    envVars: [
      { name: "SENDGRID_API_KEY", secret: true, prefixes: ["SG."], description: "SendGrid key" },
    ],
    keyPage: "https://app.sendgrid.com/settings/api_keys",
    docsUrl:
      "https://www.twilio.com/docs/sendgrid/api-reference/api-key-permissions/retrieve-a-list-of-scopes-for-which-this-user-has-access",
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
    docsUrl: "https://www.twilio.com/docs/usage/requests-to-twilio",
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
    docsUrl: "https://postmarkapp.com/developer/api/server-api",
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
    docsUrl:
      "https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/verify/",
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
  // AI providers. Each verify call is a documented, free, read-only GET.
  {
    id: "mistral",
    displayName: "Mistral",
    packages: ["@mistralai/mistralai", "@ai-sdk/mistral"],
    envVars: [{ name: "MISTRAL_API_KEY", secret: true, description: "Mistral API key" }],
    keyPage: "https://console.mistral.ai",
    docsUrl: "https://docs.mistral.ai/api/endpoint/models",
    host: "api.mistral.ai",
    auth: { type: "bearer", secret: "MISTRAL_API_KEY" },
    verifyPath: "/v1/models",
    blockedPaths: [],
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    packages: ["@ai-sdk/deepseek"],
    envVars: [{ name: "DEEPSEEK_API_KEY", secret: true, description: "DeepSeek API key" }],
    keyPage: "https://platform.deepseek.com/api_keys",
    docsUrl: "https://api-docs.deepseek.com/api/list-models",
    host: "api.deepseek.com",
    auth: { type: "bearer", secret: "DEEPSEEK_API_KEY" },
    verifyPath: "/models",
    blockedPaths: [],
  },
  {
    id: "cohere",
    displayName: "Cohere",
    packages: ["cohere-ai"],
    envVars: [{ name: "CO_API_KEY", secret: true, description: "Cohere API key" }],
    keyPage: "https://dashboard.cohere.com/api-keys",
    docsUrl: "https://docs.cohere.com/reference/list-models",
    host: "api.cohere.com",
    auth: { type: "bearer", secret: "CO_API_KEY" },
    verifyPath: "/v1/models",
    blockedPaths: [],
  },
  {
    id: "cerebras",
    displayName: "Cerebras",
    packages: ["@cerebras/cerebras_cloud_sdk"],
    envVars: [{ name: "CEREBRAS_API_KEY", secret: true, description: "Cerebras API key" }],
    keyPage: "https://cloud.cerebras.ai",
    docsUrl: "https://inference-docs.cerebras.ai/api-reference/models",
    host: "api.cerebras.ai",
    auth: { type: "bearer", secret: "CEREBRAS_API_KEY" },
    verifyPath: "/v1/models",
    blockedPaths: [],
  },
  {
    id: "replicate",
    displayName: "Replicate",
    packages: ["replicate"],
    envVars: [{ name: "REPLICATE_API_TOKEN", secret: true, description: "Replicate API token" }],
    keyPage: "https://replicate.com/account/api-tokens",
    docsUrl: "https://replicate.com/docs/reference/http#account.get",
    host: "api.replicate.com",
    auth: { type: "bearer", secret: "REPLICATE_API_TOKEN" },
    verifyPath: "/v1/account",
    blockedPaths: [],
  },
  {
    id: "elevenlabs",
    displayName: "ElevenLabs",
    packages: ["@elevenlabs/elevenlabs-js"],
    envVars: [{ name: "ELEVENLABS_API_KEY", secret: true, description: "ElevenLabs API key" }],
    keyPage: "https://elevenlabs.io/app/settings/api-keys",
    docsUrl: "https://elevenlabs.io/docs/api-reference/user/get",
    host: "api.elevenlabs.io",
    auth: { type: "header", name: "xi-api-key", secret: "ELEVENLABS_API_KEY" },
    verifyPath: "/v1/user",
    blockedPaths: [/\/(api-keys|service-accounts)\b/],
  },
  {
    id: "gemini",
    displayName: "Google Gemini",
    packages: ["@google/genai"],
    envVars: [
      {
        name: "GEMINI_API_KEY",
        secret: true,
        description: "Gemini API key (the SDKs prefer GOOGLE_API_KEY when both are set)",
      },
    ],
    keyPage: "https://aistudio.google.com/apikey",
    docsUrl: "https://ai.google.dev/api/models",
    host: "generativelanguage.googleapis.com",
    auth: { type: "header", name: "x-goog-api-key", secret: "GEMINI_API_KEY" },
    verifyPath: "/v1beta/models",
    blockedPaths: [],
  },
  {
    id: "pinecone",
    displayName: "Pinecone",
    packages: ["@pinecone-database/pinecone"],
    envVars: [{ name: "PINECONE_API_KEY", secret: true, description: "Pinecone API key" }],
    keyPage: "https://app.pinecone.io/organizations/-/projects",
    docsUrl: "https://docs.pinecone.io/reference/api/latest/control-plane/list_indexes",
    host: "api.pinecone.io",
    auth: {
      type: "header",
      name: "Api-Key",
      secret: "PINECONE_API_KEY",
      extra: { "X-Pinecone-Api-Version": "2026-07" },
    },
    verifyPath: "/indexes",
    blockedPaths: [/^\/admin\b/],
  },
  {
    id: "deepgram",
    displayName: "Deepgram",
    packages: ["@deepgram/sdk"],
    envVars: [{ name: "DEEPGRAM_API_KEY", secret: true, description: "Deepgram API key" }],
    keyPage: "https://console.deepgram.com",
    docsUrl: "https://developers.deepgram.com/reference/manage/projects/list",
    host: "api.deepgram.com",
    auth: { type: "header", name: "Authorization", prefix: "Token ", secret: "DEEPGRAM_API_KEY" },
    verifyPath: "/v1/projects",
    blockedPaths: [/\/keys\b/],
  },
  {
    id: "assemblyai",
    displayName: "AssemblyAI",
    packages: ["assemblyai"],
    envVars: [{ name: "ASSEMBLYAI_API_KEY", secret: true, description: "AssemblyAI API key" }],
    keyPage: "https://www.assemblyai.com/dashboard/home",
    docsUrl: "https://www.assemblyai.com/docs/api-reference/transcripts/list",
    host: "api.assemblyai.com",
    // The raw key, with no "Bearer".
    auth: { type: "header", name: "Authorization", secret: "ASSEMBLYAI_API_KEY" },
    verifyPath: "/v2/transcript",
    blockedPaths: [],
  },
  {
    id: "xai",
    displayName: "xAI",
    packages: ["@ai-sdk/xai"],
    envVars: [{ name: "XAI_API_KEY", secret: true, description: "xAI API key" }],
    keyPage: "https://console.x.ai/team/default/api-keys",
    docsUrl: "https://docs.x.ai/docs/tutorial",
    unverifiable: "xAI's docs list no free, read-only endpoint to check a key with.",
  },
  {
    id: "together",
    displayName: "Together AI",
    packages: ["together-ai"],
    envVars: [{ name: "TOGETHER_API_KEY", secret: true, description: "Together AI API key" }],
    keyPage: "https://api.together.ai/settings/projects/~current/api-keys",
    docsUrl: "https://docs.together.ai/docs/api-keys-authentication",
    unverifiable: "Together's docs list no free, read-only endpoint to check a key with.",
  },
];
