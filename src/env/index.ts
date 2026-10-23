import { ensureGitignore } from "./gitignore.js";
import { type EnvEntry, envExamplePath, envPath, upsertEnvFile } from "./envfile.js";

export * from "./envfile.js";
export { ensureGitignore } from "./gitignore.js";

export interface EnvWriteResult {
  envChanged: boolean;
  exampleChanged: boolean;
  gitignoreChanged: boolean;
}

/**
 * Write entries to .env, mirror them into .env.example (public values blanked),
 * and make sure .env is gitignored. Entry values must be placeholders or public keys.
 */
export function writeProjectEnv(
  root: string,
  entries: (EnvEntry & { secret: boolean })[],
  header: string,
): EnvWriteResult {
  const gitignoreChanged = ensureGitignore(root);
  const envChanged = upsertEnvFile(
    envPath(root),
    entries.map(({ key, value }) => ({ key, value })),
    header,
  );
  const exampleChanged = upsertEnvFile(
    envExamplePath(root),
    entries.map(({ key, value, secret }) => ({ key, value: secret ? value : "" })),
    header,
  );
  return { envChanged, exampleChanged, gitignoreChanged };
}
