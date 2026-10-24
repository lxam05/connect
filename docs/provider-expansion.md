# Provider expansion

Goal: Keysmith should connect hundreds of providers, not seven. This document is the spec for getting there without weakening what Keysmith promises.

## Principles

1. **Local-first.** Keys live in the user's OS keychain. `.env` holds `keysmith://` placeholders. No Keysmith server ever stores, sees or relays a third-party secret. A hosted product (team sync, web dashboard) is out of scope until it has its own threat model.
2. **The agent never sees a secret.** Every new provider goes through the same paths as today: CLI read in-process, hidden paste dialog, or import from `.env`/Vercel. No tool, log, error or API response returns a value.
3. **Never claim a key works unless a check passed.** A provider without a safe verify endpoint is stored and reported as _not verified_.
4. **Breadth comes from data, depth from code.** Most providers are a catalog entry. Only providers with a CLI, OAuth or provisioning API get a dedicated recipe.
5. **Every fact has a source.** Endpoints, env var names, key pages and scopes come from the provider's official docs, linked in the entry. Nothing is guessed.

## Current state (October 2026)

| Concept                         | Where                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------ |
| Provider interface              | `Recipe` in `src/recipes/types.ts` (detect, connect, verify, rotate, auth)     |
| Data-driven providers           | `CATALOG` in `src/recipes/catalog.ts`, turned into recipes by `pasteRecipe`    |
| Hand-written providers          | `stripe`, `stripe-webhook`, `resend`, `supabase`, `neon`                       |
| Connection paths                | `Tier`: `provisioning-api`, `cli`, `oauth`, `capture`, `derived`, `imported`   |
| Public vs secret values         | `EnvVarSpec.secret`, `vaultOnly`                                               |
| Several credentials per service | Twilio (SID + token), Clerk (secret + publishable), Cloudflare (token + id)    |
| Detection                       | `scan.ts`: packages, `process.env.X` references, `.env.example`                |
| Proxy                           | `request()` uses `Recipe.hosts`, `blockedPaths`, `auth()`; refuses live writes |
| Leak tests                      | `redact.test.ts`, `guard.test.ts`, `proxy.test.ts`, per-recipe tests           |

## Support levels

Every recipe declares `support`. Users and agents see it in `keysmith list` and `list_services`.

| `support`        | Meaning                                                                                      | How it's built        |
| ---------------- | -------------------------------------------------------------------------------------------- | --------------------- |
| `dedicated`      | Keysmith obtains the key itself (CLI, OAuth or provisioning API), verifies it, may rotate it | Hand-written `Recipe` |
| `verified-paste` | User pastes into the hidden dialog; Keysmith verifies against a documented read endpoint     | `CATALOG` entry       |
| `catalog-only`   | User pastes into the hidden dialog; no safe verify endpoint, so the key is stored unverified | `CATALOG` entry       |
| `custom`         | Any env var Keysmith has no entry for                                                        | The `custom` recipe   |

A catalog-only entry still earns its place: `scan` detects the provider, the dialog opens the right key page, the value is shape-checked and redacted from output. `verify` returns `ok: true, unverified: true` with the reason. Setup counts it separately from verified services.

## Catalog entry format

Shared fields (`src/recipes/catalog.ts`):

| Field         | Required | Notes                                                                      |
| ------------- | -------- | -------------------------------------------------------------------------- |
| `id`          | yes      | Lowercase, stable, used in `keysmith connect <id>`                         |
| `displayName` | yes      |                                                                            |
| `packages`    | yes      | npm packages that signal the provider (may be empty if none are official)  |
| `envVars`     | yes      | Names the provider's own docs and SDKs use. `secret`, `prefixes`/`pattern` |
| `keyPage`     | yes      | Official page where the user creates the key                               |
| `docsUrl`     | yes      | Official doc page that confirms the env var names and the verify endpoint  |

Verified entries add `host`, `auth`, `verifyPath`, `blockedPaths`. Catalog-only entries add `unverifiable`: one sentence saying why Keysmith can't check the key.

### Verify endpoint rules

A `verifyPath` must be all of:

- documented on an official page (`docsUrl`);
- read-only, with no side effects;
- free: no tokens, credits or usage billed;
- on a fixed host. Per-account hosts (e.g. a database's own REST URL) are not supported yet, so those providers are catalog-only.

If any rule fails, the entry is catalog-only.

### Blocked paths

Any path that creates, lists or deletes keys, or manages the account or organization, goes in `blockedPaths`. The proxy refuses them.

## Onboarding checklist (per provider)

1. Find the official docs page for authentication. Record it as `docsUrl`.
2. Copy env var names exactly as the official SDK or docs use them.
3. Add `prefixes` or `pattern` only if the docs state the key format.
4. Record the official key-creation page as `keyPage`.
5. Pick the level: dedicated only if there is an official CLI, OAuth app or provisioning API Keysmith can use without the user pasting. Otherwise check the verify rules above.
6. List key-management and account paths in `blockedPaths`.
7. Add tests with `fakeFetch`: connect stores the value and writes a placeholder; a rejected key saves nothing; verify and proxy work; the value never appears in `.env`, results or errors.
8. Run `npm test`, `npm run lint`, `npm run typecheck`.

## Template

```ts
// Verified paste
{
  id: "example",
  displayName: "Example",
  packages: ["example-sdk"],
  envVars: [{ name: "EXAMPLE_API_KEY", secret: true, description: "Example API key" }],
  keyPage: "https://example.com/settings/keys",
  docsUrl: "https://docs.example.com/authentication",
  host: "api.example.com",
  auth: { type: "bearer", secret: "EXAMPLE_API_KEY" },
  verifyPath: "/v1/me",
  blockedPaths: [/^\/v1\/api_keys\b/],
},

// Catalog only
{
  id: "example-db",
  displayName: "Example DB",
  packages: ["@example/db"],
  envVars: [
    { name: "EXAMPLE_DB_URL", secret: false, description: "Database URL" },
    { name: "EXAMPLE_DB_TOKEN", secret: true, description: "Database token" },
  ],
  keyPage: "https://console.example.com",
  docsUrl: "https://docs.example.com/db/quickstart",
  unverifiable: "Each database has its own host, which Keysmith can't verify against yet.",
},
```

## Batches

Each batch ends with tests, lint and typecheck passing. The next batch starts only after that.

1. **Support levels and tracer bullet** (done in this change). `support` on every recipe, the catalog-only path, `unverified` in verify and setup results. Tracers: Groq (verified paste) and Upstash Redis (catalog only).
2. **Backfill and site data.** Add `docsUrl` to the existing catalog entries. Generate `site/catalog.json` from `CATALOG` at build time and render a searchable list on the site.
3. **New dedicated recipes.** GitHub (via the `gh` CLI) and Railway (CLI or project token), each confirmed against official docs first.
4. **Google Cloud.** Service-account JSON is a multi-line, file-shaped credential. It needs a new value kind in the vault and in `keysmith run` (e.g. write to a private temp file and set `GOOGLE_APPLICATION_CREDENTIALS`).
5. **Category batches of about 20** (AI, email, auth, databases, payments, observability, storage). Each entry follows the checklist.

## Open questions

- **Linux and Windows.** `@napi-rs/keyring` is cross-platform; the hidden paste dialog (osascript) is not. Wider platform support mostly means a new dialog.
- **Per-account hosts.** Supporting them would turn several catalog-only providers into verified ones. The proxy's host allow-list must then come from a stored, non-secret value, with care that it can't be pointed at an arbitrary host.
- **Logos.** Provider marks are trademarks. Use names only until there is a clear policy.
