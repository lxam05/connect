import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Side-effecting OS access, injectable so recipes can be tested without a real machine. */
export interface System {
  which(cmd: string): Promise<string | null>;
  /** Run a command. Secrets must never be passed in `args`; use `input` (stdin) instead. */
  exec(
    cmd: string,
    args: string[],
    opts?: { input?: string; timeoutMs?: number },
  ): Promise<ExecResult>;
  /** Start a long-running command without waiting for it. */
  spawnBackground(cmd: string, args: string[]): BackgroundProcess;
  open(url: string): Promise<void>;
  readFile(path: string): string | null;
  homedir(): string;
  env: Record<string, string | undefined>;
}

export interface BackgroundProcess {
  done: Promise<ExecResult>;
  kill(): void;
}

function run(
  cmd: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs ?? 120_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

export const realSystem: System = {
  async which(cmd) {
    const r = await run("/usr/bin/which", [cmd]);
    return r.code === 0 ? r.stdout.trim() || null : null;
  },
  exec: run,
  spawnBackground(cmd, args) {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    const done = new Promise<ExecResult>((resolve) => {
      child.on("error", (e) => resolve({ code: 1, stdout, stderr: stderr + String(e) }));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
    return { done, kill: () => child.kill() };
  },
  async open(url) {
    if (!/^https:\/\//.test(url)) throw new Error(`refusing to open non-https url: ${url}`);
    await run("/usr/bin/open", [url]);
  },
  readFile(path) {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  },
  homedir,
  env: process.env,
};
