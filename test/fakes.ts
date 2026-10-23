import type { CaptureRequest, CaptureResult, SecretCapture } from "../src/capture/index.js";
import { createContext } from "../src/app.js";
import type { ConnectOptions } from "../src/recipes/types.js";
import type { BackgroundProcess, ExecResult, System } from "../src/sys.js";
import { memoryVault, tmp } from "./helpers.js";

export class FakeCapture implements SecretCapture {
  requests: CaptureRequest[] = [];
  constructor(private readonly values: string[]) {}
  async capture(req: CaptureRequest): Promise<CaptureResult> {
    this.requests.push(req);
    const value = this.values.shift();
    if (value === undefined) return { ok: false, reason: "canceled", message: "canceled" };
    const problem = req.validate(value);
    return problem ? { ok: false, reason: "invalid", message: problem } : { ok: true, value };
  }
}

export interface FakeSysOptions {
  files?: Record<string, string>;
  which?: Record<string, string>;
  exec?: (cmd: string, args: string[]) => ExecResult;
  background?: (cmd: string, args: string[]) => Promise<ExecResult>;
}

export function fakeSys(o: FakeSysOptions = {}): System & { opened: string[]; calls: string[][] } {
  const opened: string[] = [];
  const calls: string[][] = [];
  return {
    opened,
    calls,
    async which(cmd) {
      return o.which?.[cmd] ?? null;
    },
    async exec(cmd, args) {
      calls.push([cmd, ...args]);
      return o.exec?.(cmd, args) ?? { code: 0, stdout: "", stderr: "" };
    },
    spawnBackground(cmd, args): BackgroundProcess {
      calls.push([cmd, ...args]);
      return {
        done: o.background?.(cmd, args) ?? Promise.resolve({ code: 0, stdout: "", stderr: "" }),
        kill() {},
      };
    },
    async open(url) {
      opened.push(url);
    },
    readFile(path) {
      return o.files?.[path] ?? null;
    },
    homedir: () => "/home/test",
    env: {},
  };
}

export type Route = (req: {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}) => Response | undefined;

export function fakeFetch(routes: Route[]) {
  const log: { method: string; url: string; auth: string | null; body: string }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    log.push({ method, url: url.toString(), auth: headers.get("authorization"), body });
    for (const r of routes) {
      const res = r({ method, url, headers, body });
      if (res) return res;
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  }) as typeof fetch;
  return { fetch: f, log };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export function makeCtx(opts: {
  capture?: SecretCapture;
  sys?: System;
  fetch?: typeof fetch;
  options?: ConnectOptions;
  now?: Date;
}) {
  const root = tmp("keysmith-proj-");
  const { vault, keychain } = memoryVault();
  const ctx = createContext({
    project: { root, name: "demo" },
    vault,
    capture: opts.capture ?? new FakeCapture([]),
    sys: opts.sys ?? fakeSys(),
    fetch: opts.fetch ?? fakeFetch([]).fetch,
    options: opts.options,
    now: () => opts.now ?? new Date("2026-10-23T12:00:00Z"),
  });
  return { ctx, root, vault, keychain };
}
