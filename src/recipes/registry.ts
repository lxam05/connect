import { resend } from "./resend.js";
import { stripe } from "./stripe.js";
import { stripeWebhook } from "./stripe-webhook.js";
import type { Recipe } from "./types.js";

export const recipes: Recipe[] = [stripe, stripeWebhook, resend];

export function getRecipe(id: string): Recipe {
  const recipe = recipes.find((r) => r.id === id.toLowerCase().trim());
  if (!recipe) {
    throw new Error(`Unknown service "${id}". Available: ${recipes.map((r) => r.id).join(", ")}`);
  }
  return recipe;
}
