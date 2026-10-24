import type { SecretCapture } from "../capture/index.js";
import type { ProjectContext } from "../context.js";
import type { System } from "../sys.js";
import type { Mode, Tier, Vault } from "../vault/index.js";

export interface EnvVarSpec {
  name: string;
  secret: boolean;
  /** Stored in the vault only (e.g. an admin key for rotation), never in .env. */
  vaultOnly?: boolean;
  description: string;
}

export interface ConnectOptions {
  /** Force a specific tier instead of trying them in order. */
  tier?: "auto" | "cli" | "capture";
  /** CLI usage: block and wait for browser approvals instead of returning action_required. */
  wait?: boolean;
  /** Replace an existing connection (Stripe recipes only), e.g. to switch accounts. */
  force?: boolean;
}

export interface RecipeContext {
  project: ProjectContext;
  vault: Vault;
  capture: SecretCapture;
  sys: System;
  fetch: typeof fetch;
  now: () => Date;
  options: ConnectOptions;
  /** Progress messages for humans. Must never contain secret values. */
  progress: (msg: string) => void;
}

export type ConnState = "connected" | "not_connected" | "incomplete" | "expired";

export interface Status {
  service: string;
  displayName: string;
  state: ConnState;
  mode?: Mode;
  tier?: Tier;
  account?: string;
  accountName?: string;
  expires?: string | null;
  expiringSoon?: boolean;
  /** Env vars that are missing from the vault or .env. */
  missing?: string[];
}

export type Outcome = "connected" | "already_connected" | "repaired" | "action_required" | "failed";

export interface ConnectResult {
  service: string;
  outcome: Outcome;
  message: string;
  tier?: Tier;
  /** Things the human must do (or approve) before the agent calls again. */
  humanSteps?: string[];
  warnings?: string[];
  /** Env vars now present in .env (names only). */
  envVars?: string[];
  account?: string;
  accountName?: string;
  mode?: Mode;
  expires?: string | null;
}

export interface VerifyResult {
  service: string;
  ok: boolean;
  message: string;
  account?: string;
  accountName?: string;
  mode?: Mode;
  warnings?: string[];
}

export interface AuthInjection {
  headers: Record<string, string>;
  /** Values injected, so responses can be redacted. */
  secrets: string[];
  mode: Mode;
}

export interface Recipe {
  id: string;
  displayName: string;
  envVars: EnvVarSpec[];
  /** Hosts the proxy may call for this service. */
  hosts: string[];
  /** Connection paths in the order they're tried. */
  tiers: Tier[];
  /** Human steps that may be needed, in plain words. */
  humanSteps: string[];
  detect(ctx: RecipeContext): Promise<Status>;
  connect(ctx: RecipeContext): Promise<ConnectResult>;
  verify(ctx: RecipeContext): Promise<VerifyResult>;
  rotate?(ctx: RecipeContext): Promise<ConnectResult>;
  /** Auth for proxied requests; null when not connected. */
  auth(ctx: RecipeContext): AuthInjection | null;
  /** Encode a JSON body the way the provider expects. Defaults to JSON. */
  encodeBody?(body: unknown): { body: string; contentType: string };
  /** Paths the proxy refuses (e.g. endpoints that mint or return secrets). */
  blockedPaths?: RegExp[];
}
