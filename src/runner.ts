import { spawn } from "node:child_process";
import { constants } from "node:os";
import { join } from "node:path";
import type { ProjectContext } from "./context.js";
import { readEnvFile } from "./env/index.js";
import { Redactor, createRedactStream } from "./redact.js";
import { type Vault, isRef, parseRef } from "./vault/index.js";

/** Env files read by the runner, later ones overriding earlier ones (Next.js order). */
const ENV_FILES = [".env", ".env.local"];

export class MissingSecretError extends Error {
  constructor(
    readonly envVar: string,
    readonly service: string,
  ) {
    super(`${envVar} is not in the vault. Run: keysmith connect ${service}`);
  }
}

export interface ResolvedEnv {
  /** Variables to inject into the child (real values for placeholders). */
  env: Record<string, string>;
  /** Keys whose values came from the vault. */
  secretKeys: Set<string>;
  redactor: Redactor;
}

/** Load .env files and resolve every keysmith:// placeholder from the vault. */
export function resolveProjectEnv(project: ProjectContext, vault: Vault): ResolvedEnv {
  const merged = new Map<string, string>();
  for (const file of ENV_FILES) {
    for (const [k, v] of readEnvFile(join(project.root, file))) merged.set(k, v);
  }
  const env: Record<string, string> = {};
  const redactor = new Redactor();
  const secretKeys = new Set<string>();
  for (const [key, value] of merged) {
    if (!isRef(value)) {
      env[key] = value;
      continue;
    }
    const { service } = parseRef(value);
    const secret = vault.resolve(value);
    if (secret === null) throw new MissingSecretError(key, service);
    env[key] = secret;
    secretKeys.add(key);
    redactor.add(secret);
  }
  return { env, secretKeys, redactor };
}

export interface RunOptions {
  project: ProjectContext;
  vault: Vault;
  command: string;
  args: string[];
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/**
 * Spawn `command` with resolved secrets in its environment only. Child stdout/stderr
 * pass through a redactor so secret values never reach the terminal or logs.
 */
export function runWithSecrets(opts: RunOptions): Promise<number> {
  const { env: resolved, secretKeys, redactor } = resolveProjectEnv(opts.project, opts.vault);
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  if (secretKeys.size === 0) {
    stderr.write(
      `keysmith: no keysmith:// placeholders in ${join(opts.project.root, ".env")}, running without injected secrets.\n`,
    );
  }

  // Values already set in the shell win for plain vars (dotenv semantics);
  // resolved placeholders always win, since the shell can only hold the placeholder.
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [k, v] of Object.entries(resolved)) {
    if (secretKeys.has(k) || env[k] === undefined) env[k] = v;
  }
  // Piping loses the TTY; keep colors when the parent terminal supports them.
  if ((stdout as { isTTY?: boolean }).isTTY && env.FORCE_COLOR === undefined) env.FORCE_COLOR = "1";

  return new Promise((resolve, reject) => {
    const child = spawn(opts.command, opts.args, {
      cwd: process.cwd(),
      env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    child.stdout.pipe(createRedactStream(redactor)).pipe(stdout, { end: false });
    child.stderr.pipe(createRedactStream(redactor)).pipe(stderr, { end: false });

    const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
    const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((s) => {
      const h = forward(s);
      process.on(s, h);
      return [s, h] as const;
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      for (const [s, h] of handlers) process.off(s, h);
      resolve(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0));
    });
  });
}
