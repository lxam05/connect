export type Mode = "test" | "live";

/** Which connection path produced a secret. */
export type Tier = "provisioning-api" | "cli" | "oauth" | "capture" | "derived";

export interface SecretMeta {
  ref: string;
  project: string;
  service: string;
  envVar: string;
  mode: Mode;
  tier: Tier;
  created: string;
  expires: string | null;
  /** Kept in the vault only (e.g. an admin key used for rotation), never written to .env. */
  vaultOnly?: boolean;
  /** Provider-side identifier of the key (not secret), used for rotation/revocation. */
  providerKeyId?: string;
  /** Provider account identifier (not secret). */
  account?: string;
}

export type NewSecretMeta = Omit<
  SecretMeta,
  "ref" | "project" | "service" | "envVar" | "created"
> & {
  created?: string;
};
