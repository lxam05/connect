# Keysmith

Type `/keysmith` and your project gets every API key it needs: stored in the macOS Keychain, with placeholders in `.env`, without your coding agent ever seeing a secret.

```
you:    /keysmith
agent:  setup → found Stripe, Supabase, OpenAI and FOO_API_KEY; moved 1 plain-text secret into the Keychain
        → "approve the Stripe pairing code in your browser", "paste your OpenAI key into the dialog"
you:    *click Allow, paste one key*
agent:  setup → "Done: 4 services connected and verified. npm run dev now injects them."
```

Keys go into the macOS Keychain. `.env` only ever contains placeholders:

```dotenv
# Stripe (managed by keysmith)
STRIPE_SECRET_KEY=keysmith://myapp/stripe/STRIPE_SECRET_KEY
STRIPE_PUBLISHABLE_KEY=pk_test_…            # public by design
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_…
# Resend (managed by keysmith)
RESEND_API_KEY=keysmith://myapp/resend/RESEND_API_KEY
```

Real values are injected only at runtime:

```json
{ "scripts": { "dev": "keysmith run -- next dev" } }
```

Anything the child prints that matches a secret is replaced with `[keysmith:redacted]`.

> MVP: macOS only. Stripe uses test keys only; Supabase, Neon and Resend have no test mode, so their keys are real.

## Install

```bash
npm install -g keysmith          # or: npm link, from this repo
```

Then, in Claude Code, install the plugin. It adds `/keysmith`, the MCP server and a hook that blocks the agent from reading credentials:

```
/plugin marketplace add lxam05/connect
/plugin install keysmith@keysmith
```

Without the plugin: `claude mcp add keysmith -- keysmith mcp`, then `keysmith doctor --fix`.

## What setup does

`/keysmith`, `keysmith setup` and the MCP `setup` tool all run the same steps, and are safe to repeat:

1. **Scan** (`keysmith scan` shows this without changing anything): dependencies, `process.env.X` / `import.meta.env.X` references in source files, and `.env.example`.
2. **Import** existing secrets without printing them. Plain-text secrets in `.env`, `.env.local` and friends move into the Keychain. If the folder is linked to Vercel, its development env vars are pulled into a private temp file, imported, and the file is deleted.
3. **Connect** each needed service through its recipe (below). Secret-looking vars with no recipe are stored as custom secrets through the hidden dialog.
4. **Dev script**: `"dev": "next dev"` becomes `"dev": "keysmith run -- next dev"` (skip with `--no-dev-script`).
5. **Verify** every service and report account names, mismatches and anything a person still has to do.

## CLI

| Command                          | What it does                                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keysmith setup`                 | Give the project every key it needs (see above). `--no-dev-script` leaves `package.json` alone.                                                                                             |
| `keysmith scan`                  | Show which services and secrets the project needs. Changes nothing.                                                                                                                         |
| `keysmith add FOO_API_KEY`       | Store any other secret via the hidden dialog. `--url` opens the page where it's created.                                                                                                    |
| `keysmith list`                  | Services and the human steps each may need                                                                                                                                                  |
| `keysmith connect stripe resend` | Get keys, store in Keychain, write placeholders. Idempotent. `--tier capture` skips CLIs and asks you to paste. `--force` replaces an existing Stripe connection (e.g. to switch accounts). |
| `keysmith status`                | Connected services, mode, account, expiry (no values). `--all` includes services that aren't connected.                                                                                     |
| `keysmith verify [service]`      | Proves keys work against a harmless read endpoint                                                                                                                                           |
| `keysmith rotate resend`         | New key → verify → swap in vault → revoke old key                                                                                                                                           |
| `keysmith run -- <cmd>`          | Run with real values injected, output redacted                                                                                                                                              |
| `keysmith doctor [--fix]`        | Checks agent deny rules, `.gitignore`, Keychain access, Stripe CLI. `--fix` adds missing deny rules to `.claude/settings.json` and fixes `.gitignore`.                                      |
| `keysmith mcp`                   | MCP server over stdio                                                                                                                                                                       |
| `keysmith guard`                 | Claude Code PreToolUse hook (used by the plugin): blocks tool calls that would read credentials                                                                                             |

There is deliberately **no** `get`/`reveal` command.

## MCP tools

`setup(devScript?)`, `scan`, `add_secret(name, url?)`, `list_services`, `connect(service, tier?, project?)`, `status`, `verify(service)`, `rotate(service, confirm?)`, `request(service, method, path, body?)`.

All return metadata only. `rotate` asks for confirmation via MCP elicitation when the client supports it, otherwise it returns `confirmation_required` and needs `confirm: true` after the user says yes; what it does per service is in `list_services` → `rotation`. `request` proxies a call to the service's API (Stripe, Resend and the catalog services) with auth injected and the response redacted. Key-management endpoints are blocked, and mutating calls on live keys are refused.

`keysmith run` is not exposed over MCP.

## How each service connects

**Stripe**

1. Uses the Stripe CLI (`stripe login --non-interactive`, device flow). You approve a pairing code in the browser. If the CLI isn't installed, the agent is told to ask you before running `brew install stripe/stripe-cli/stripe`.
2. Reads the CLI's test-mode restricted key + publishable key from `~/.config/stripe/config.toml` in-process (never modifies it). CLI keys last 90 days; `status` warns 14 days before expiry.
3. Verifies with `GET /v1/balance` (must be `livemode: false`) and checks the key can use Checkout. If it can't, it falls back to the dashboard page + secure paste and tells you why.
4. Records the account (`GET /v1/account`) and shows it in `connect`, `status` and `verify`. If the Stripe CLI is on a different account, it warns and prints the `stripe switch` command, because `stripe listen` would forward events from the wrong account.
5. Profile: set `KEYSMITH_STRIPE_PROFILE` to use a `stripe login --project-name` profile.

**Stripe webhooks** (`keysmith connect stripe-webhook`)

1. Reads the signing secret with `stripe listen --print-secret` in-process, stores it in the Keychain and writes `STRIPE_WEBHOOK_SECRET=keysmith://…` to `.env`.
2. Refuses if the Stripe CLI is on a different account from the Stripe key, since the secret would be for the wrong account.
3. Run the forwarder as `keysmith run -- stripe listen --forward-to localhost:3000/<route>`, so the secret `stripe listen` prints is redacted. Bare `stripe listen` is in the recommended deny rules.
4. `verify` checks the stored secret still matches what `stripe listen` uses, without returning either.

**Resend**

Resend has no OAuth/provisioning API, and `resend login` only stores a pasted key, so:

1. If the Resend CLI already holds exactly one full-access key, reuse it. Otherwise open resend.com/api-keys and show a **hidden-input macOS dialog**. The pasted key goes dialog → Keychain without touching the agent or terminal.
2. Use that full-access key to create a **sending-access** key via `POST /api-keys`. Only the sending key goes into `.env`; the full-access key stays in the Keychain (vault-only) for rotation.
3. `rotate` creates a new sending key, verifies it, swaps it in the vault, then deletes the old key. Running processes must restart to pick it up.

Note: Resend has no test-mode keys. Until you verify a domain, Resend only delivers to your own address, which serves as the sandbox.

**Supabase** (no paste): uses the Supabase CLI (`supabase login` once). Takes the project this folder is linked to, the only project, or the one you pick (`--project`). Reads the keys with `supabase projects api-keys` in-process and writes `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (public by design) and `SUPABASE_SERVICE_ROLE_KEY` (Keychain). Verified against the project's REST endpoint.

**Neon** (no paste): uses `neonctl` (`neonctl auth` once). Picks the project the same way and stores `DATABASE_URL` from `neonctl connection-string`. Verify checks the connection string's shape; Keysmith doesn't open database connections.

**GitHub** (one paste): opens the page for creating a fine-grained token, the least-privilege option, and takes it in the hidden dialog. Verified with `GET /user`, which records the user. `--tier cli` reuses the GitHub CLI's token instead (`gh auth token`); that token has every scope `gh` has, so Keysmith warns about it. GitHub has no test mode, so `request` is read-only, and key, secret and token endpoints are blocked.

**Railway** (one paste): Railway only creates project tokens in the dashboard (project → Settings → Tokens). Paste one into the dialog; Keysmith verifies it with Railway's `projectToken` query and records the project and environment. Run the CLI as `keysmith run -- railway up`.

**Vercel** (no paste, import): if the folder is linked (`vercel link`), setup runs `vercel env pull` for the development environment into a private temp file, routes each var to the recipe that owns it (or to custom secrets), and deletes the file.

**Guided paste** (one dialog each, verified against a harmless read endpoint, usable through `request`, which is read-only unless the provider has documented test keys, like Clerk's `sk_test_`): OpenAI, Anthropic, Groq, Mistral, DeepSeek, Cohere, Cerebras, Replicate, ElevenLabs, Google Gemini, Pinecone, Deepgram, AssemblyAI, Clerk, SendGrid, Twilio, Postmark and Cloudflare. Cloudflare API tokens can't be created from a CLI login, so you paste the token once; `CLOUDFLARE_ACCOUNT_ID` is filled in from it.

**Catalog only** (one dialog each, stored and redacted but **not verified**, because there's no safe endpoint to check against): Upstash Redis, xAI and Together AI. `verify` and `setup` report these as "stored, not verified".

Every service has a support level (`dedicated`, `verified-paste`, `catalog-only` or `custom`), shown by `keysmith list`. How to add one: [docs/provider-expansion.md](docs/provider-expansion.md).

**Anything else**: `keysmith add VAR` (or the MCP `add_secret`) stores it via the hidden dialog. Keysmith can't verify unknown services.

## Threat model

**Protects against** secrets ending up in `.env`, git, logs, terminal output, chat transcripts, screenshots, and the agent's context window.

- No CLI command, MCP tool or log returns a secret. The vault's `resolve()` is used only by the runner and proxy.
- Secrets are never passed as command-line arguments (visible in `ps`).
- `~/.keysmith/index.json` (0600) holds metadata only: service, env var, mode, created, expiry, tier, provider key id.
- `.env` gets placeholders; `.gitignore` is fixed up (including un-ignoring `.env.example` under Next.js's `.env*`).

**Known gap: same-user processes.** On macOS, any process running as you can potentially read Keychain items whose ACL trusts the binary that created them (here: `node`). An agent with unrestricted shell access could call `security find-generic-password -s keysmith …`, write a Node script using the same binding, or read `~/.config/stripe/config.toml` directly. Keysmith can't stop a determined same-user process in this version. Mitigations:

- The plugin's `keysmith guard` hook blocks Keychain reads (`security find-generic-password`, keyring scripts), reads of credential folders (`~/.keysmith`, `~/.config/stripe`, `~/.supabase`, …) in any form, and commands that print secrets (`stripe listen`, `supabase projects api-keys`, `vercel env pull`, `neonctl connection-string`) unless they run as `keysmith run -- …`.
- `keysmith doctor` checks that your Claude Code settings deny the obvious paths, and `keysmith doctor --fix` adds any that are missing to `.claude/settings.json`. Recommended `permissions.deny`:

  ```json
  [
    "Bash(security find-generic-password*)",
    "Bash(security find-internet-password*)",
    "Bash(security dump-keychain*)",
    "Read(~/.keysmith/**)",
    "Read(~/.config/stripe/**)",
    "Read(~/.config/resend/**)",
    "Bash(cat ~/.config/stripe/*)",
    "Bash(stripe config --list*)",
    "Bash(stripe listen*)",
    "Bash(supabase projects api-keys*)",
    "Bash(vercel env pull*)",
    "Bash(neonctl connection-string*)",
    "Read(~/.supabase/**)",
    "Read(~/.config/neonctl/**)"
  ]
  ```

  These are guardrails, not a sandbox. An agent can still write a script that does the same thing.

- `keysmith run` redacts exact secret values and well-known key shapes. It won't catch a secret that a program transforms (e.g. base64-encodes) before printing.
- Roadmap: a signed helper app that owns the Keychain items with a user-presence access control (Touch ID), with the CLI/MCP talking to it over a local socket; and a local HTTP proxy so even the running app only holds placeholders.

## 60-second demo

```bash
npx create-next-app@latest shop --yes && cd shop
keysmith doctor --fix
claude mcp add keysmith -- keysmith mcp
claude "add Stripe payments and Resend email"
#   → approve the Stripe pairing code in your browser
#   → paste one Resend key into the macOS dialog
cat .env                                   # placeholders + pk_test_ only
grep -rE "sk_test_|rk_test_|re_[A-Za-z0-9]{8}" . --exclude-dir=node_modules   # nothing
keysmith run -- node -e 'console.log(process.env.STRIPE_SECRET_KEY)'          # [keysmith:redacted]
npm pkg set scripts.dev="keysmith run -- next dev" && npm run dev
keysmith connect stripe resend             # "already connected" ×2
keysmith rotate resend
```

## Development

```bash
npm install
npm run build && npm test && npm run lint
```

Layout: `src/vault` (Keychain + metadata index), `src/env` (`.env` writer), `src/runner.ts`, `src/redact.ts`, `src/capture` (macOS dialog), `src/recipes` (one file per provider, `catalog.ts` + `paste.ts` for guided-paste services, `custom.ts`, plus the `Recipe` interface), `src/sources` (imports from `.env` files and Vercel), `src/scan.ts`, `src/setup.ts`, `src/guard.ts`, `src/proxy`, `src/mcp/server.ts`, `src/doctor.ts`, `src/cli.ts`. The Claude Code plugin is in `plugin/`, listed by `.claude-plugin/marketplace.json`.

Adding a guided-paste provider is one entry in `src/recipes/catalog.ts`. A provider with a CLI or API that can mint keys gets its own `Recipe` (`detect`, `connect`, `verify`, optional `rotate`, `auth`, `hosts`, `signals`) in `src/recipes/<id>.ts`, registered in `registry.ts`. `connect` tries tiers in order: provisioning API → provider CLI → OAuth → guided page + secure capture.

## Roadmap

- Stripe managed API keys (`POST /v2/iam/api_keys`, keys encrypted to our public key) as the zero-touch tier.
- Signed Keychain helper with Touch ID; local HTTP proxy.
- More recipes; live mode behind explicit confirmation; Linux/Windows backends.
