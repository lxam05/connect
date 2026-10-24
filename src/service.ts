import { custom } from "./recipes/custom.js";
import { recipes, getRecipe } from "./recipes/registry.js";
import type { ConnectResult, RecipeContext, Status, VerifyResult } from "./recipes/types.js";

/** Operations shared by the CLI and MCP server. Every return value is metadata only. */

export function listServices() {
  return recipes.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    support: r.support,
    envVars: r.envVars
      .filter((v) => !v.vaultOnly)
      .map((v) => ({ name: v.name, secret: v.secret, description: v.description })),
    tiers: r.tiers,
    humanSteps: r.humanSteps,
    canRotate: Boolean(r.rotate),
    rotation: r.rotation,
    modeLabel: r.modeLabel,
  }));
}

export async function connect(ctx: RecipeContext, service: string): Promise<ConnectResult> {
  return getRecipe(service).connect(ctx);
}

export async function status(
  ctx: RecipeContext,
): Promise<{ project: string; root: string; services: Status[] }> {
  const services = await Promise.all(recipes.map((r) => r.detect(ctx)));
  return { project: ctx.project.name, root: ctx.project.root, services };
}

export async function verify(ctx: RecipeContext, service: string): Promise<VerifyResult> {
  return getRecipe(service).verify(ctx);
}

export async function rotate(ctx: RecipeContext, service: string): Promise<ConnectResult> {
  const recipe = getRecipe(service);
  if (!recipe.rotate)
    return {
      service,
      outcome: "failed",
      message: `${recipe.displayName} does not support rotation yet.`,
    };
  return recipe.rotate(ctx);
}

/** Store secrets for services Keysmith has no recipe for, via the hidden dialog. */
export async function addSecret(
  ctx: RecipeContext,
  names: string[],
  opts: { url?: string; force?: boolean } = {},
): Promise<ConnectResult> {
  ctx.options = { ...ctx.options, vars: names, url: opts.url, force: opts.force };
  return custom.connect(ctx);
}

export { scanProject as scan } from "./scan.js";
export { setupProject as setup } from "./setup.js";
