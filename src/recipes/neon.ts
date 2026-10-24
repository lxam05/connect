import {
  accountLabel,
  alreadyConnected,
  chooseProject,
  detectFromState,
  failed,
  persist,
  refFor,
  repairEnv,
} from "./common.js";
import type { ConnectResult, Recipe, RecipeContext, VerifyResult } from "./types.js";

const DATABASE_URL = "DATABASE_URL";
const INSTALL_CMD = "npm install -g neonctl";

interface Project {
  id: string;
  name: string;
}

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
  const r = await ctx.sys.exec("neonctl", ["projects", "list", "--output", "json"], {
    timeoutMs: 30_000,
  });
  if (r.code !== 0) return null;
  const parsed = parseJson(r.stdout) as { projects?: unknown } | unknown[] | undefined;
  const rows = Array.isArray(parsed) ? parsed : (parsed?.projects ?? []);
  if (!Array.isArray(rows)) return null;
  return rows
    .map((p: { id?: string; name?: string }) => ({ id: p.id ?? "", name: p.name ?? "" }))
    .filter((p) => p.id);
}

/** Checks the shape of a connection string without opening a connection. */
function describeUrl(value: string): { ok: true; host: string } | { ok: false; message: string } {
  try {
    const url = new URL(value);
    if (!/^postgres(ql)?:$/.test(url.protocol))
      return { ok: false, message: "not a postgres:// connection string" };
    if (!url.password) return { ok: false, message: "the connection string has no password" };
    return { ok: true, host: url.hostname };
  } catch {
    return { ok: false, message: "the connection string couldn't be parsed" };
  }
}

export const neon: Recipe = {
  id: "neon",
  displayName: "Neon",
  support: "dedicated",
  envVars: [{ name: DATABASE_URL, secret: true, description: "Postgres connection string" }],
  hosts: [],
  tiers: ["cli"],
  humanSteps: [
    "Sign in with `neonctl auth` (opens the browser), unless the Neon CLI is already signed in.",
    "Pick a project if the account has more than one.",
  ],
  signals: { packages: ["@neondatabase/serverless"] },
  rotation:
    "Not automatic: reset the role's password in the Neon console, then run `keysmith connect neon --force`.",

  async detect(ctx) {
    return detectFromState(ctx, this);
  },

  async connect(ctx): Promise<ConnectResult> {
    const status = await this.detect(ctx);
    if (status.state === "connected" && !ctx.options.force) return alreadyConnected(this, status);
    const repaired = repairEnv(ctx, this, status);
    if (repaired) return repaired;

    if (!(await ctx.sys.which("neonctl"))) {
      return {
        service: this.id,
        outcome: "action_required",
        message: `The Neon CLI is not installed. Ask the user for permission, then run \`${INSTALL_CMD}\` and call connect again.`,
        humanSteps: [`Approve installing the Neon CLI: ${INSTALL_CMD}`],
      };
    }
    const projects = await listProjects(ctx);
    if (!projects) {
      return {
        service: this.id,
        outcome: "action_required",
        message:
          "The Neon CLI isn't signed in. Ask the user to run `neonctl auth` in a terminal (it opens the browser), then call connect again.",
        humanSteps: ["Run `neonctl auth` in a terminal and approve it in the browser."],
      };
    }
    const wanted = ctx.options.project;
    const project =
      projects.find((p) => p.id === wanted || p.name === wanted) ??
      (projects.length === 1 && !wanted ? projects[0] : undefined);
    if (!project) {
      if (!projects.length)
        return failed(
          this,
          "This Neon account has no projects yet. Create one at https://console.neon.tech.",
        );
      return chooseProject(ctx, this, "project", projects);
    }

    const r = await ctx.sys.exec("neonctl", ["connection-string", "--project-id", project.id], {
      timeoutMs: 30_000,
    });
    const value =
      r.code === 0
        ? r.stdout
            .trim()
            .split(/\s+/)
            .find((w) => /^postgres/.test(w))
        : undefined;
    if (!value)
      return failed(this, `The Neon CLI didn't return a connection string for ${project.name}.`);
    const shape = describeUrl(value);
    if (!shape.ok) return failed(this, `Unexpected connection string: ${shape.message}.`);

    const envVars = persist(ctx, this, [
      {
        envVar: DATABASE_URL,
        value,
        meta: {
          mode: "live",
          tier: "cli",
          expires: null,
          account: project.id,
          accountName: project.name,
        },
      },
    ]);
    return {
      service: this.id,
      outcome: "connected",
      message: `Neon connected, project ${accountLabel(project.id, project.name)} (host ${shape.host}).`,
      tier: "cli",
      envVars,
      account: project.id,
      accountName: project.name,
      mode: "live",
      warnings: [
        "Neon has no test mode: DATABASE_URL points at a real database. Consider a dev branch.",
      ],
    };
  },

  async verify(ctx): Promise<VerifyResult> {
    const ref = refFor(ctx, this, DATABASE_URL);
    const value = ctx.vault.resolve(ref);
    const meta = ctx.vault.meta(ref);
    if (!value)
      return { service: this.id, ok: false, message: "Not connected. Call connect first." };
    const shape = describeUrl(value);
    if (!shape.ok)
      return {
        service: this.id,
        ok: false,
        message: `DATABASE_URL looks wrong: ${shape.message}.`,
      };
    return {
      service: this.id,
      ok: true,
      message: `DATABASE_URL is a valid connection string for ${shape.host}${meta?.account ? ` (project ${accountLabel(meta.account, meta.accountName)})` : ""}. Keysmith doesn't open database connections.`,
      account: meta?.account,
      accountName: meta?.accountName,
      mode: "live",
    };
  },

  auth() {
    return null;
  },
};
