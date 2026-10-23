import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Patterns that already keep .env out of git. */
const COVERS_ENV = new Set([".env", "/.env", ".env*", "/.env*", "*.env"]);
const WILDCARD = new Set([".env*", "/.env*"]);

/**
 * Make sure `.env` is gitignored and `.env.example` is not.
 * Returns true if .gitignore was modified.
 */
export function ensureGitignore(root: string): boolean {
  const path = join(root, ".gitignore");
  const content = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = content.split(/\r?\n/).map((l) => l.trim());
  const additions: string[] = [];
  if (!lines.some((l) => COVERS_ENV.has(l))) additions.push(".env");
  const wildcard = lines.some((l) => WILDCARD.has(l));
  if (wildcard && !lines.includes("!.env.example")) additions.push("!.env.example");
  if (!additions.length) return false;
  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  writeFileSync(
    path,
    `${content}${prefix}\n# keysmith: real values live in the Keychain\n${additions.join("\n")}\n`,
  );
  return true;
}
