import { join } from "node:path";
import { readEnvFile } from "../env/index.js";
import type { RecipeContext } from "../recipes/types.js";
import { type ImportResult, importSecrets, looksSecret } from "./import.js";

/** Env files that may hold plain secrets, in Next.js load order. */
const FILES = [".env", ".env.local", ".env.development", ".env.development.local"];

/** Names of secret-looking vars holding real values in this project's env files. */
export function plaintextSecrets(ctx: RecipeContext): string[] {
  const names = new Set<string>();
  for (const file of FILES) {
    for (const [name, value] of readEnvFile(join(ctx.project.root, file))) {
      if (value && !value.startsWith("keysmith://") && looksSecret(name, value)) names.add(name);
    }
  }
  return [...names].sort();
}

/** Move plain secrets from the project's env files into the Keychain. */
export function importDotenv(ctx: RecipeContext): ImportResult {
  const values = new Map<string, string>();
  for (const file of FILES) {
    for (const [name, value] of readEnvFile(join(ctx.project.root, file))) {
      if (value && !value.startsWith("keysmith://") && looksSecret(name, value))
        values.set(name, value);
    }
  }
  const others = FILES.slice(1).map((f) => join(ctx.project.root, f));
  return importSecrets(ctx, values, "dotenv", others);
}
