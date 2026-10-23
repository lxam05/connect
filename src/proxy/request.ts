import { Redactor, redactJson } from "../redact.js";
import { getRecipe } from "../recipes/registry.js";
import type { RecipeContext } from "../recipes/types.js";

export type Method = "GET" | "POST" | "DELETE" | "PATCH" | "PUT";
const MUTATING = new Set<Method>(["POST", "DELETE", "PATCH", "PUT"]);
const MAX_BODY_CHARS = 100_000;

export interface ProxyResponse {
  status: number;
  ok: boolean;
  /** Parsed JSON (or text), with secret values and secret-looking fields redacted. */
  body: unknown;
  truncated?: boolean;
}

export class ProxyError extends Error {}

/**
 * Call a provider API on the agent's behalf. Auth is injected here and never returned;
 * the response is redacted before it leaves this function.
 */
export async function proxyRequest(
  ctx: RecipeContext,
  service: string,
  method: Method,
  path: string,
  body?: unknown,
): Promise<ProxyResponse> {
  const recipe = getRecipe(service);
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new ProxyError("path must start with a single '/'");
  const host = recipe.hosts[0]!;
  const url = new URL(path, `https://${host}`);
  if (url.protocol !== "https:" || !recipe.hosts.includes(url.host)) {
    throw new ProxyError(`host ${url.host} is not allowed for ${service}`);
  }
  if (recipe.blockedPaths?.some((re) => re.test(url.pathname))) {
    throw new ProxyError(
      `${url.pathname} manages keys and can't be called through the proxy. Use connect/rotate instead.`,
    );
  }

  const auth = recipe.auth(ctx);
  if (!auth) throw new ProxyError(`${service} is not connected. Call connect("${service}") first.`);
  if (MUTATING.has(method) && auth.mode !== "test") {
    throw new ProxyError(`${method} requests on live-mode keys are not allowed.`);
  }

  const headers: Record<string, string> = { ...auth.headers, "User-Agent": "keysmith/0.1" };
  let payload: string | undefined;
  if (body !== undefined && method !== "GET") {
    const encoded = recipe.encodeBody?.(body) ?? {
      body: JSON.stringify(body),
      contentType: "application/json",
    };
    payload = encoded.body;
    headers["Content-Type"] = encoded.contentType;
  }

  const res = await ctx.fetch(url, { method, headers, body: payload });
  const redactor = new Redactor(auth.secrets);
  for (const meta of ctx.vault.list({ project: ctx.project.name, service })) {
    const v = ctx.vault.resolve(meta.ref);
    if (v) redactor.add(v);
  }

  let text = await res.text();
  let truncated = false;
  if (text.length > MAX_BODY_CHARS) {
    text = text.slice(0, MAX_BODY_CHARS);
    truncated = true;
  }
  let parsed: unknown;
  try {
    parsed = redactJson(JSON.parse(text), redactor);
  } catch {
    parsed = redactor.redact(text);
  }
  return { status: res.status, ok: res.ok, body: parsed, truncated: truncated || undefined };
}
