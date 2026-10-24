import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { envExamplePath, readEnvFile } from "./env/index.js";
import { custom } from "./recipes/custom.js";
import { catalog, dedicated, ownerOf } from "./recipes/registry.js";
import type { ConnState, RecipeContext } from "./recipes/types.js";
import { plaintextSecrets } from "./sources/dotenv.js";
import { looksSecret } from "./sources/import.js";
import { vercelLinked } from "./sources/vercel.js";

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|astro)$/;
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".vercel",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
]);
const ENV_REF =
  /process\.env\.([A-Z_][A-Z0-9_]*)|process\.env\[\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\]|import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g;
export const SCAN_LIMITS = { files: 5_000, bytes: 512 * 1024 };

export interface ScanService {
  id: string;
  displayName: string;
  kind: "dedicated" | "catalog" | "custom";
  /** Why the project needs it, e.g. "dependency stripe". */
  reasons: string[];
  envVars: string[];
  state: ConnState;
  account?: string;
  accountName?: string;
}

export interface ScanResult {
  project: string;
  root: string;
  services: ScanService[];
  /** Secret-looking env vars with no recipe; setup stores them as custom secrets. */
  unmatched: { name: string; reasons: string[]; stored: boolean }[];
  /** Env vars holding real secret values in plain text (names only). */
  plaintext: string[];
  /** The project is linked to Vercel, so setup can import its env vars. */
  vercel: boolean;
  devScript: { present: boolean; usesKeysmith: boolean };
  /** True when the file walk stopped at SCAN_LIMITS.files. */
  truncated: boolean;
}

/** Env var references in source files: name → first few "file" locations. */
function codeRefs(root: string): { refs: Map<string, string[]>; truncated: boolean } {
  const refs = new Map<string, string[]>();
  let files = 0;
  let truncated = false;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(path);
        continue;
      }
      if (!e.isFile() || !SOURCE_EXT.test(e.name)) continue;
      if (++files > SCAN_LIMITS.files) {
        truncated = true;
        return;
      }
      if (statSync(path).size > SCAN_LIMITS.bytes) continue;
      const text = readFileSync(path, "utf8");
      for (const m of text.matchAll(ENV_REF)) {
        const name = m[1] ?? m[2] ?? m[3]!;
        const where = refs.get(name) ?? [];
        const file = relative(root, path);
        if (!where.includes(file) && where.length < 3) where.push(file);
        refs.set(name, where);
      }
    }
  };
  walk(root);
  return { refs, truncated };
}

function readPackage(root: string): { deps: Set<string>; dev?: string } {
  const path = join(root, "package.json");
  if (!existsSync(path)) return { deps: new Set() };
  try {
    const pkg = JSON.parse(readFileSync(path, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    return {
      deps: new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ]),
      dev: pkg.scripts?.dev,
    };
  } catch {
    return { deps: new Set() };
  }
}

/** Work out which services and secrets this project needs. Read-only, no network. */
export async function scanProject(ctx: RecipeContext): Promise<ScanResult> {
  const root = ctx.project.root;
  const pkg = readPackage(root);
  const example = readEnvFile(envExamplePath(root));
  const { refs, truncated } = codeRefs(root);

  const reasonsFor = (name: string): string[] => [
    ...(refs.get(name) ?? []).map((f) => `process.env.${name} in ${f}`),
    ...(example.has(name) ? [`.env.example lists ${name}`] : []),
  ];

  const services: ScanService[] = [];
  for (const recipe of [...dedicated, ...catalog]) {
    const reasons = [
      ...(recipe.signals?.packages ?? [])
        .filter((p) => pkg.deps.has(p))
        .map((p) => `dependency ${p}`),
      ...recipe.envVars.flatMap((v) => reasonsFor(v.name)),
    ];
    if (!reasons.length) continue;
    const status = await recipe.detect(ctx);
    services.push({
      id: recipe.id,
      displayName: recipe.displayName,
      kind: dedicated.includes(recipe) ? "dedicated" : "catalog",
      reasons: reasons.slice(0, 4),
      envVars: recipe.envVars.filter((v) => !v.vaultOnly).map((v) => v.name),
      state: status.state,
      account: status.account,
      accountName: status.accountName,
    });
  }

  const candidates = new Set([...refs.keys(), ...example.keys()]);
  const unmatched = [...candidates]
    .filter((name) => !ownerOf(name) && looksSecret(name))
    .sort()
    .map((name) => ({
      name,
      reasons: reasonsFor(name).slice(0, 3),
      stored: ctx.vault.has(ctx.vault.ref(ctx.project.name, custom.id, name)),
    }));

  return {
    project: ctx.project.name,
    root,
    services,
    unmatched,
    plaintext: plaintextSecrets(ctx),
    vercel: vercelLinked(ctx),
    devScript: { present: Boolean(pkg.dev), usesKeysmith: /^keysmith run\b/.test(pkg.dev ?? "") },
    truncated,
  };
}
