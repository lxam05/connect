import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountLabel,
  alreadyConnected,
  chooseProject,
  describeHttpError,
  detectFromState,
  failed,
  persist,
  refFor,
  repairEnv,
} from "./common.js";
import type { ConnectResult, Recipe, RecipeContext, VerifyResult } from "./types.js";

const URL_VAR = "NEXT_PUBLIC_SUPABASE_URL";
const ANON = "NEXT_PUBLIC_SUPABASE_ANON_KEY";
const SERVICE = "SUPABASE_SERVICE_ROLE_KEY";
const INSTALL_CMD = "brew install supabase/tap/supabase";
/** The CLI writes a supabase/.temp cache into its workdir; keep that out of the project. */
const WORKDIR = ["--workdir", tmpdir()];

interface Project {
  ref: string;
  name: string;
  /** e.g. ACTIVE_HEALTHY, INACTIVE (paused), COMING_UP. */
  status?: string;
}

const isPaused = (p: Project) => p.status === "INACTIVE" || p.status === "PAUSING";

/** Parse the CLI's stdout as JSON without ever echoing it. */
function parseJson(stdout: string): unknown {
  const start = stdout.search(/[[{]/);
  if (start < 0) return undefined;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
}

async function listProjects(ctx: RecipeContext): Promise<Project[] | null> {
  const r = await ctx.sys.exec("supabase", ["projects", "list", "-o", "json", ...WORKDIR], {
    timeoutMs: 30_000,
  });
  if (r.code !== 0) return null;
  const rows = parseJson(r.stdout);
  if (!Array.isArray(rows)) return null;
  return rows
    .map((p: { ref?: string; id?: string; name?: string; status?: string }) => ({
      ref: p.ref ?? p.id ?? "",
      name: p.name ?? "",
      status: p.status,
    }))
    .filter((p) => /^[a-z0-9]{10,}$/.test(p.ref));
}

/** The project this folder is linked to with `supabase link`, if any. */
function linkedRef(ctx: RecipeContext): string | null {
  const raw = ctx.sys.readFile(join(ctx.project.root, "supabase", ".temp", "project-ref"));
  return raw?.trim() || null;
}

async function apiKeys(
  ctx: RecipeContext,
  ref: string,
): Promise<{ anon: string; service: string } | null> {
  const r = await ctx.sys.exec(
    "supabase",
    ["projects", "api-keys", "--project-ref", ref, "-o", "json", ...WORKDIR],
    {
      timeoutMs: 30_000,
    },
  );
  if (r.code !== 0) return null;
  const rows = parseJson(r.stdout);
  if (!Array.isArray(rows)) return null;
  const byName = new Map(
    rows.map((k: { name?: string; api_key?: string }) => [k.name ?? "", k.api_key ?? ""]),
  );
  // Prefer the classic JWT keys most code expects; fall back to the newer key names.
  const anon = byName.get("anon") || byName.get("publishable");
  const service = byName.get("service_role") || byName.get("secret");
  return anon && service ? { anon, service } : null;
}

async function serviceKeyWorks(ctx: RecipeContext, ref: string, key: string): Promise<Response> {
  return ctx.fetch(`https://${ref}.supabase.co/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, "User-Agent": "keysmith/0.1" },
  });
}

export const supabase: Recipe = {
  id: "supabase",
  displayName: "Supabase",
  support: "dedicated",
  envVars: [
    { name: URL_VAR, secret: false, description: "Project URL (public)" },
    {
      name: ANON,
      secret: false,
      description: "Anon key (public by design, row-level security applies)",
    },
    { name: SERVICE, secret: true, description: "Service role key (bypasses row-level security)" },
  ],
  hosts: [],
  tiers: ["cli"],
  humanSteps: [
    "Sign in with `supabase login` (opens the browser), unless the Supabase CLI is already signed in.",
    "Pick a project if the account has more than one and this folder isn't linked.",
  ],
  signals: {
    packages: ["@supabase/supabase-js", "@supabase/ssr", "@supabase/auth-helpers-nextjs"],
  },
  rotation:
    "Not automatic: roll the keys in the Supabase dashboard, then run `keysmith connect supabase --force`.",

  async detect(ctx) {
    return detectFromState(ctx, this);
  },

  async connect(ctx): Promise<ConnectResult> {
    const status = await this.detect(ctx);
    if (status.state === "connected" && !ctx.options.force) return alreadyConnected(this, status);
    const repaired = repairEnv(ctx, this, status);
    if (repaired) return repaired;

    if (!(await ctx.sys.which("supabase"))) {
      return {
        service: this.id,
        outcome: "action_required",
        message: `The Supabase CLI is not installed. Ask the user for permission, then run \`${INSTALL_CMD}\` and call connect again.`,
        humanSteps: [`Approve installing the Supabase CLI: ${INSTALL_CMD}`],
      };
    }
    const projects = await listProjects(ctx);
    if (!projects) {
      return {
        service: this.id,
        outcome: "action_required",
        message:
          "The Supabase CLI isn't signed in. Ask the user to run `supabase login` in a terminal (it opens the browser), then call connect again.",
        humanSteps: ["Run `supabase login` in a terminal and approve it in the browser."],
      };
    }
    const wanted = ctx.options.project ?? linkedRef(ctx);
    const project =
      projects.find((p) => p.ref === wanted || p.name === wanted) ??
      (projects.length === 1 && !wanted ? projects[0] : undefined);
    if (!project) {
      if (!projects.length)
        return failed(
          this,
          "This Supabase account has no projects yet. Create one at https://supabase.com/dashboard.",
        );
      return chooseProject(
        ctx,
        this,
        "project",
        projects.map((p) => ({
          id: p.ref,
          name: p.name,
          note: isPaused(p) ? "paused" : undefined,
        })),
      );
    }
    if (isPaused(project)) {
      return {
        service: this.id,
        outcome: "action_required",
        message: `The Supabase project ${accountLabel(project.ref, project.name)} is paused, so it has no API keys to read. Restore it in the dashboard (it can take a few minutes), then connect again, or pick another project.`,
        humanSteps: [
          `Restore ${project.name} at https://supabase.com/dashboard/project/${project.ref}, then run setup again.`,
        ],
      };
    }

    ctx.progress(`Reading API keys for Supabase project ${project.name}…`);
    const keys = await apiKeys(ctx, project.ref);
    if (!keys)
      return failed(
        this,
        `The Supabase CLI returned no API keys for ${accountLabel(project.ref, project.name)} (status ${project.status ?? "unknown"}). If the project was just restored, wait a minute and try again.`,
      );
    const res = await serviceKeyWorks(ctx, project.ref, keys.service);
    if (!res.ok)
      return failed(
        this,
        `Supabase rejected the service role key (${await describeHttpError(res)}).`,
      );

    const meta = {
      mode: "live" as const,
      tier: "cli" as const,
      expires: null,
      account: project.ref,
      accountName: project.name,
    };
    const envVars = persist(ctx, this, [
      { envVar: URL_VAR, value: `https://${project.ref}.supabase.co` },
      { envVar: ANON, value: keys.anon },
      { envVar: SERVICE, value: keys.service, meta },
    ]);
    return {
      service: this.id,
      outcome: "connected",
      message: `Supabase connected, project ${accountLabel(project.ref, project.name)}. The service role key is in the Keychain; the URL and anon key are public by design.`,
      tier: "cli",
      envVars,
      account: project.ref,
      accountName: project.name,
      mode: "live",
      warnings: [
        "Supabase projects have no test mode: the service role key works on real data and bypasses row-level security. Use it on the server only.",
      ],
    };
  },

  async verify(ctx): Promise<VerifyResult> {
    const ref = refFor(ctx, this, SERVICE);
    const key = ctx.vault.resolve(ref);
    const meta = ctx.vault.meta(ref);
    if (!key || !meta?.account)
      return { service: this.id, ok: false, message: "Not connected. Call connect first." };
    const res = await serviceKeyWorks(ctx, meta.account, key);
    return res.ok
      ? {
          service: this.id,
          ok: true,
          message: `${SERVICE} works (project ${accountLabel(meta.account, meta.accountName)}).`,
          account: meta.account,
          accountName: meta.accountName,
          mode: "live",
        }
      : {
          service: this.id,
          ok: false,
          message: `Supabase rejected the key (${await describeHttpError(res)}).`,
        };
  },

  auth() {
    // Data access goes through the app; Keysmith doesn't proxy Supabase.
    return null;
  },
};
