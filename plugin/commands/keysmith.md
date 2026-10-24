---
description: Get every API key this project needs into the Keychain, with placeholders in .env
argument-hint: "[optional: services or env vars to focus on]"
---

Give this project every API key it needs using Keysmith. You never see a secret value: keys go into the macOS Keychain, `.env` gets `keysmith://` placeholders, and `keysmith run` adds the real values when the app runs.

Extra instructions from the user: $ARGUMENTS

1. Check that the `keysmith` CLI is installed with `keysmith --version`. If it isn't, ask the user before running `npm install -g keysmith`. Then ask them to restart Claude Code so the plugin's MCP server and hook start.
2. Run `keysmith doctor --fix` and tell the user in one line what it fixed.
3. Call the keysmith `setup` tool. It scans the project, moves plain-text secrets into the Keychain, imports Vercel env vars when the folder is linked, connects each service, changes the dev script to `keysmith run -- …`, and verifies.
4. If the result has `humanSteps`, tell the user exactly what to do, in order. That might be approving a pairing code in the browser, signing in to a CLI, choosing a project, or pasting a key into a hidden macOS dialog. Wait for them, then call `setup` again. Repeat until `done` is true or the user stops.
   - When a service asks to choose a project or account, ask the user, then call `connect` with `project` set to their choice.
   - Never install software without asking.
   - Never ask the user to paste a key into `.env`, a file or this chat. For anything Keysmith has no recipe for, call `add_secret`.
5. Finish with a short report:
   - each service with its account or project name, and any warning (for example a Stripe CLI on a different account, or a service with no test mode)
   - which secrets were moved out of plain text
   - the dev script change
   - a single closing line, such as: "Done: 4 keys are in your Keychain, .env holds placeholders, and `npm run dev` injects them."

Don't print, read or echo secret values at any point. If a step fails, say what failed and what the user can do next.
