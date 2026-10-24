import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface EnvEntry {
  key: string;
  value: string;
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?$/;

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) {
    const inner = v.slice(1, -1);
    return v[0] === '"' ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"') : inner;
  }
  // Strip trailing inline comments on unquoted values.
  return v.replace(/\s+#.*$/, "");
}

/** Minimal dotenv parser: KEY=VALUE, optional `export`, quotes, comments. */
export function parseEnv(content: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = LINE.exec(line);
    if (m) out.set(m[1]!, unquote(m[2] ?? ""));
  }
  return out;
}

export function readEnvFile(path: string): Map<string, string> {
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : new Map();
}

function formatValue(value: string): string {
  return /^[A-Za-z0-9_./:@+-]*$/.test(value) ? value : JSON.stringify(value);
}

/**
 * Insert or replace KEY=VALUE lines, leaving every other line (and comments) untouched.
 * Returns the new content and whether anything changed.
 */
export function upsertEnvContent(
  content: string,
  entries: EnvEntry[],
  header?: string,
): { content: string; changed: boolean } {
  const lines = content === "" ? [] : content.replace(/\r?\n$/, "").split(/\r?\n/);
  let changed = false;
  const appended: string[] = [];
  for (const { key, value } of entries) {
    const line = `${key}=${formatValue(value)}`;
    const idx = lines.findIndex((l) => LINE.exec(l)?.[1] === key);
    if (idx >= 0) {
      if (lines[idx] !== line) {
        lines[idx] = line;
        changed = true;
      }
    } else {
      appended.push(line);
      changed = true;
    }
  }
  if (appended.length) {
    if (lines.length && lines.at(-1) !== "") lines.push("");
    if (header && !lines.includes(header)) lines.push(header);
    lines.push(...appended);
  }
  return { content: lines.join("\n") + "\n", changed };
}

export function upsertEnvFile(path: string, entries: EnvEntry[], header?: string): boolean {
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const { content, changed } = upsertEnvContent(before, entries, header);
  if (changed) writeFileSync(path, content, { mode: 0o600 });
  return changed;
}

/** Delete KEY=… lines for `keys`, leaving everything else untouched. */
export function removeEnvKeys(path: string, keys: string[]): boolean {
  if (!existsSync(path) || !keys.length) return false;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const kept = lines.filter((l) => !keys.includes(LINE.exec(l)?.[1] ?? ""));
  if (kept.length === lines.length) return false;
  writeFileSync(path, kept.join("\n"), { mode: 0o600 });
  return true;
}

export const envPath = (root: string) => join(root, ".env");
export const envExamplePath = (root: string) => join(root, ".env.example");
