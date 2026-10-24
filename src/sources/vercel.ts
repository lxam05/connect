import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnvFile } from "../env/index.js";
import type { RecipeContext } from "../recipes/types.js";
import { type ImportResult, importSecrets } from "./import.js";

/** True when this folder is linked to a Vercel project (`vercel link`). */
export function vercelLinked(ctx: RecipeContext): boolean {
  return existsSync(join(ctx.project.root, ".vercel", "project.json"));
}

/**
 * Pull the Vercel project's development env vars into a private temp file, import them,
 * and always delete the file. Values never reach stdout.
 */
export async function importVercel(
  ctx: RecipeContext,
): Promise<ImportResult | { error: string; humanSteps?: string[] }> {
  if (!vercelLinked(ctx)) return { error: "This folder isn't linked to a Vercel project." };
  if (!(await ctx.sys.which("vercel"))) {
    return {
      error: "The Vercel CLI is not installed.",
      humanSteps: ["Approve installing the Vercel CLI: npm install -g vercel"],
    };
  }
  const dir = mkdtempSync(join(tmpdir(), "keysmith-vercel-"));
  const file = join(dir, "pulled.env");
  try {
    const r = await ctx.sys.exec(
      "vercel",
      ["env", "pull", file, "--environment=development", "--yes", "--cwd", ctx.project.root],
      { timeoutMs: 60_000 },
    );
    if (r.code !== 0) {
      return {
        error: "`vercel env pull` failed. The Vercel CLI may not be signed in.",
        humanSteps: ["Run `vercel login` in a terminal."],
      };
    }
    const values = readEnvFile(file);
    // Vercel's own system vars (e.g. a short-lived OIDC token) aren't app keys.
    for (const name of [...values.keys()]) if (name.startsWith("VERCEL_")) values.delete(name);
    return importSecrets(ctx, values, "Vercel");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
