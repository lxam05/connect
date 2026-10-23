import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProjectContext } from "./context.js";
import { ensureGitignore } from "./env/index.js";
import type { System } from "./sys.js";
import type { KeychainBackend } from "./vault/keychain.js";

/** Deny rules that stop a coding agent from reading secrets around Keysmith. */
export const RECOMMENDED_DENY = [
  "Bash(security find-generic-password*)",
  "Bash(security find-internet-password*)",
  "Bash(security dump-keychain*)",
  "Read(~/.keysmith/**)",
  "Read(~/.config/stripe/**)",
  "Read(~/.config/resend/**)",
  "Bash(cat ~/.config/stripe/*)",
  "Bash(stripe config --list*)",
];

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function denyRules(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const json = JSON.parse(readFileSync(path, "utf8")) as { permissions?: { deny?: unknown } };
    const deny = json.permissions?.deny;
    return Array.isArray(deny) ? deny.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

export async function runDoctor(
  project: ProjectContext,
  sys: System,
  keychain: KeychainBackend,
  opts: { fixGitignore?: boolean } = {},
): Promise<Check[]> {
  const checks: Check[] = [];

  const settingsFiles = [
    join(homedir(), ".claude", "settings.json"),
    join(project.root, ".claude", "settings.json"),
    join(project.root, ".claude", "settings.local.json"),
  ];
  const deny = new Set(settingsFiles.flatMap(denyRules));
  const missing = RECOMMENDED_DENY.filter((r) => !deny.has(r));
  checks.push({
    name: "Claude Code deny rules",
    ok: missing.length === 0,
    detail: missing.length
      ? `Missing ${missing.length} rule(s). Add to .claude/settings.json → permissions.deny:\n${JSON.stringify(missing, null, 2)}`
      : "All recommended deny rules are set.",
  });

  const gitignorePath = join(project.root, ".gitignore");
  if (opts.fixGitignore) ensureGitignore(project.root);
  const gi = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const ignored = /^\/?(\.env\*?|\*\.env)$/m.test(gi);
  checks.push({
    name: ".env is gitignored",
    ok: ignored,
    detail: ignored ? gitignorePath : "Run `keysmith doctor --fix` or add `.env` to .gitignore.",
  });

  try {
    const account = `_doctor/${randomBytes(4).toString("hex")}`;
    keychain.set(account, randomBytes(16).toString("hex"));
    const ok = keychain.get(account) !== null;
    keychain.delete(account);
    checks.push({
      name: "Keychain access",
      ok,
      detail: ok ? "Read/write works." : "Could not read back a test item.",
    });
  } catch (e) {
    checks.push({
      name: "Keychain access",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  const stripePath = await sys.which("stripe");
  checks.push({
    name: "Stripe CLI",
    ok: Boolean(stripePath),
    detail:
      stripePath ??
      "Not installed (needed for the zero-paste Stripe flow): brew install stripe/stripe-cli/stripe",
  });

  checks.push({
    name: "Platform",
    ok: process.platform === "darwin",
    detail: process.platform === "darwin" ? "macOS" : `${process.platform} is not supported yet.`,
  });
  return checks;
}
