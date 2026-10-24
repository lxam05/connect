# Keysmith

Let an AI coding agent add Stripe, Resend and friends to your project **by itself**, without the agent ever seeing a secret.

```
you:    add Stripe payments and Resend email
agent:  connect("stripe") → "approve pairing code BDJT-GTZJ in your browser"
you:    *click Allow*
agent:  connect("stripe") → "Stripe connected ✓ test mode, acct_1T4s…"
agent:  connect("resend") → *macOS dialog asks you to paste one key*
        → "Resend connected ✓ sending-only key stored"
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

> MVP: macOS only, test/sandbox keys only, Stripe + Resend.

## Install

```bash
npm install -g keysmith          # or: npm link, from this repo
claude mcp add keysmith -- keysmith mcp
keysmith doctor
```

## CLI

| Command                          | What it does                                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keysmith list`                  | Services and the human steps each may need                                                                                                                                                  |
| `keysmith connect stripe resend` | Get keys, store in Keychain, write placeholders. Idempotent. `--tier capture` skips CLIs and asks you to paste. `--force` replaces an existing Stripe connection (e.g. to switch accounts). |
| `keysmith status`                | Connected services, mode, expiry (no values)                                                                                                                                                |
| `keysmith verify [service]`      | Proves keys work against a harmless read endpoint                                                                                                                                           |
| `keysmith rotate resend`         | New key → verify → swap in vault → revoke old key                                                                                                                                           |
| `keysmith run -- <cmd>`          | Run with real values injected, output redacted                                                                                                                                              |
| `keysmith doctor [--fix]`        | Checks agent deny rules, `.gitignore`, Keychain access, Stripe CLI. `--fix` adds missing deny rules to `.claude/settings.json` and fixes `.gitignore`.                                      |
| `keysmith mcp`                   | MCP server over stdio                                                                                                                                                                       |

There is deliberately **no** `get`/`reveal` command.

## MCP tools

`list_services`, `connect(service, tier?)`, `status`, `verify(service)`, `rotate(service, confirm?)`, `request(service, method, path, body?)`.

All return metadata only. `rotate` asks for confirmation via MCP elicitation when the client supports it, otherwise it returns `confirmation_required` and needs `confirm: true` after the user says yes. `request` proxies a call to `api.stripe.com` / `api.resend.com` with auth injected and the response redacted. Key-management endpoints are blocked, and mutating calls on live keys are refused.

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

## Threat model

**Protects against** secrets ending up in `.env`, git, logs, terminal output, chat transcripts, screenshots, and the agent's context window.

- No CLI command, MCP tool or log returns a secret. The vault's `resolve()` is used only by the runner and proxy.
- Secrets are never passed as command-line arguments (visible in `ps`).
- `~/.keysmith/index.json` (0600) holds metadata only: service, env var, mode, created, expiry, tier, provider key id.
- `.env` gets placeholders; `.gitignore` is fixed up (including un-ignoring `.env.example` under Next.js's `.env*`).

**Known gap: same-user processes.** On macOS, any process running as you can potentially read Keychain items whose ACL trusts the binary that created them (here: `node`). An agent with unrestricted shell access could call `security find-generic-password -s keysmith …`, write a Node script using the same binding, or read `~/.config/stripe/config.toml` directly. Keysmith can't stop a determined same-user process in this version. Mitigations:

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
    "Bash(stripe listen*)"
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

Layout: `src/vault` (Keychain + metadata index), `src/env` (`.env` writer), `src/runner.ts`, `src/redact.ts`, `src/capture` (macOS dialog), `src/recipes` (one file per provider, plus the `Recipe` interface), `src/proxy`, `src/mcp/server.ts`, `src/doctor.ts`, `src/cli.ts`.

Adding a provider means implementing `Recipe` (`detect`, `connect`, `verify`, optional `rotate`, `auth`, `hosts`) in `src/recipes/<id>.ts` and registering it in `registry.ts`. `connect` tries tiers in order: provisioning API → provider CLI → OAuth → guided page + secure capture.

## Roadmap

- Stripe managed API keys (`POST /v2/iam/api_keys`, keys encrypted to our public key) as the zero-touch tier.
- Signed Keychain helper with Touch ID; local HTTP proxy.
- More recipes; live mode behind explicit confirmation; Linux/Windows backends.
