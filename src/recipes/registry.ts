import { CATALOG } from "./catalog.js";
import { custom } from "./custom.js";
import { neon } from "./neon.js";
import { pasteRecipe } from "./paste.js";
import { resend } from "./resend.js";
import { stripe } from "./stripe.js";
import { stripeWebhook } from "./stripe-webhook.js";
import { supabase } from "./supabase.js";
import type { Recipe } from "./types.js";

/** Recipes written for one provider, in the order setup connects them. */
export const dedicated: Recipe[] = [supabase, neon, stripe, stripeWebhook, resend];

/** Guided-paste recipes generated from the catalog. */
export const catalog: Recipe[] = CATALOG.map(pasteRecipe);

export const recipes: Recipe[] = [...dedicated, ...catalog, custom];

export function getRecipe(id: string): Recipe {
  const recipe = recipes.find((r) => r.id === id.toLowerCase().trim());
  if (!recipe) {
    throw new Error(`Unknown service "${id}". Available: ${recipes.map((r) => r.id).join(", ")}`);
  }
  return recipe;
}

/** The recipe that manages an env var, if any. Custom secrets have no owner. */
export function ownerOf(envVar: string): Recipe | undefined {
  return recipes.find((r) => r !== custom && r.envVars.some((v) => v.name === envVar));
}
