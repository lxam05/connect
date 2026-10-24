import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountLabel } from "./recipes/common.js";
import { custom } from "./recipes/custom.js";
import { getRecipe } from "./recipes/registry.js";
import type { ConnectResult, Outcome, RecipeContext } from "./recipes/types.js";
import { type ScanResult, scanProject } from "./scan.js";
import { importDotenv } from "./sources/dotenv.js";
import { importVercel } from "./sources/vercel.js";

export interface SetupService {
  id: string;
  displayName: string;
  outcome: Outcome;
  message: string;
  account?: string;
  accountName?: string;
  humanSteps?: string[];
  warnings?: string[];
  /** Result of verify after connecting; absent when it wasn't connected. */
  verified?: { ok: boolean; message: string; unverified?: boolean };
}

export interface SetupResult {
  project: string;
  /** Secrets moved into the Keychain from .env files or Vercel (names only). */
  imported: string[];
  services: SetupService[];
  devScript: { changed: boolean; command?: string; note?: string };
  /** Everything a person still has to do, across all services. */
  humanSteps: string[];
  /** True when every needed service is connected and verified. */
  done: boolean;
  summary: string;
}

const RUN_PREFIX = "keysmith run -- ";

/** Prefix `scripts.dev` with `keysmith run --`, keeping the file's formatting style. */
export function updateDevScript(root: string): SetupResult["devScript"] {
  const path = join(root, "package.json");
  if (!existsSync(path)) return { changed: false, note: "No package.json." };
  const raw = readFileSync(path, "utf8");
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(raw) as typeof pkg;
  } catch {
    return {
      changed: false,
      note: "package.json isn't valid JSON, so the dev script was left alone.",
    };
  }
  const dev = pkg.scripts?.dev;
  if (!dev)
    return {
      changed: false,
      note: `No dev script. Start your app with \`${RUN_PREFIX}<command>\`.`,
    };
  if (/^keysmith run\b/.test(dev)) return { changed: false, command: dev };
  pkg.scripts!.dev = `${RUN_PREFIX}${dev}`;
  const indent = /^\{\r?\n([ \t]+)"/.exec(raw)?.[1] ?? "  ";
  writeFileSync(path, JSON.stringify(pkg, null, indent) + "\n");
  return { changed: true, command: pkg.scripts!.dev };
}

function fromConnect(id: string, displayName: string, r: ConnectResult): SetupService {
  return {
    id,
    displayName,
    outcome: r.outcome,
    message: r.message,
    account: r.account,
    accountName: r.accountName,
    humanSteps: r.humanSteps,
    warnings: r.warnings,
  };
}

/**
 * Give the project every key it needs: scan, import existing secrets, connect each
 * needed service, route the dev script through keysmith, then verify. Idempotent: call
 * it again after the human steps it returns.
 */
export async function setupProject(
  ctx: RecipeContext,
  opts: { devScript?: boolean } = {},
): Promise<SetupResult> {
  const first = await scanProject(ctx);
  const imported: string[] = [];
  const humanSteps: string[] = [];
  const notes: string[] = [];

  if (first.vercel) {
    const v = await importVercel(ctx);
    if ("error" in v) {
      notes.push(`Vercel import skipped: ${v.error}`);
      humanSteps.push(...(v.humanSteps ?? []));
    } else imported.push(...v.imported);
  }
  if (first.plaintext.length) imported.push(...importDotenv(ctx).imported);

  const scan: ScanResult = imported.length ? await scanProject(ctx) : first;
  const services: SetupService[] = [];
  for (const s of scan.services) {
    const recipe = getRecipe(s.id);
    const r = await recipe.connect(ctx);
    services.push(fromConnect(s.id, s.displayName, r));
  }

  const customVars = scan.unmatched.map((u) => u.name);
  if (customVars.length) {
    const saved = ctx.options;
    ctx.options = { ...saved, vars: customVars };
    try {
      services.push(fromConnect(custom.id, custom.displayName, await custom.connect(ctx)));
    } finally {
      ctx.options = saved;
    }
  }

  const connected = (o: Outcome) =>
    o === "connected" || o === "already_connected" || o === "repaired";
  for (const s of services) {
    if (!connected(s.outcome)) {
      humanSteps.push(...(s.humanSteps ?? []));
      continue;
    }
    const saved = ctx.options;
    if (s.id === custom.id) ctx.options = { ...saved, vars: customVars };
    try {
      const v = await getRecipe(s.id).verify(ctx);
      s.verified = { ok: v.ok, message: v.message, unverified: v.unverified };
      s.account ??= v.account;
      s.accountName ??= v.accountName;
      if (v.warnings?.length) s.warnings = [...(s.warnings ?? []), ...v.warnings];
    } finally {
      ctx.options = saved;
    }
  }

  const anyManaged = services.some((s) => connected(s.outcome));
  const devScript =
    opts.devScript === false || !anyManaged
      ? {
          changed: false,
          note: opts.devScript === false ? "Left alone (--no-dev-script)." : undefined,
        }
      : updateDevScript(ctx.project.root);

  const done = services.every((s) => connected(s.outcome) && s.verified?.ok !== false);
  const ok = services.filter((s) => connected(s.outcome)).length;
  const unverified = services.filter((s) => s.verified?.unverified).length;
  const summary = !services.length
    ? "This project doesn't seem to need any API keys Keysmith knows about. Use add_secret (or `keysmith add VAR`) for others."
    : done
      ? `Done: ${ok} service(s) connected${unverified ? ` (${unverified} stored but not verifiable)` : " and verified"}. .env holds keysmith:// placeholders; real values are injected by \`keysmith run\`.${devScript.changed ? ` The dev script now runs \`${devScript.command}\`.` : ""}`
      : `${ok} of ${services.length} service(s) ready. Do the human steps, then run setup again.`;

  return {
    project: ctx.project.name,
    imported,
    services,
    devScript: {
      ...devScript,
      note: [devScript.note, ...notes].filter(Boolean).join(" ") || undefined,
    },
    humanSteps: [...new Set(humanSteps)],
    done,
    summary,
  };
}

/** One line per service for terminal output. */
export function describeSetupService(s: SetupService): string {
  const icon = s.verified
    ? s.verified.ok
      ? s.verified.unverified
        ? "·"
        : "✓"
      : "✗"
    : s.outcome === "action_required"
      ? "→"
      : "✗";
  const where = s.account ? ` · ${accountLabel(s.account, s.accountName)}` : "";
  const detail =
    s.verified && !s.verified.ok
      ? s.verified.message
      : s.verified?.unverified
        ? "stored, not verified"
        : s.verified
          ? "ready"
          : s.message;
  return `${icon} ${s.displayName}${where}: ${detail}`;
}
