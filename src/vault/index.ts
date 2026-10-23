import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type KeychainBackend, NativeKeychain } from "./keychain.js";
import { makeRef, parseRef, refAccount } from "./ref.js";
import type { NewSecretMeta, SecretMeta } from "./types.js";

export * from "./ref.js";
export type * from "./types.js";

export function keysmithHome(): string {
  return process.env.KEYSMITH_HOME ?? join(homedir(), ".keysmith");
}

interface IndexFile {
  version: 1;
  secrets: Record<string, SecretMeta>;
}

export interface VaultOptions {
  backend?: KeychainBackend;
  /** Directory holding index.json (metadata only, never values). */
  home?: string;
}

/**
 * Secret storage. Values live in the Keychain; ~/.keysmith/index.json holds metadata.
 *
 * `list`, `has` and `meta` return metadata only. `resolve` returns a value and is for
 * the runner and proxy only: it must never be reachable from a CLI command or MCP tool.
 */
export class Vault {
  private readonly backend: KeychainBackend;
  private readonly indexPath: string;
  private readonly home: string;

  constructor(opts: VaultOptions = {}) {
    this.backend = opts.backend ?? new NativeKeychain();
    this.home = opts.home ?? keysmithHome();
    this.indexPath = join(this.home, "index.json");
  }

  ref(project: string, service: string, envVar: string): string {
    return makeRef(project, service, envVar);
  }

  set(ref: string, value: string, meta: NewSecretMeta): SecretMeta {
    const { project, service, envVar } = parseRef(ref);
    if (!value) throw new Error(`refusing to store an empty value for ${ref}`);
    this.backend.set(refAccount(ref), value);
    const full: SecretMeta = {
      ...meta,
      ref,
      project,
      service,
      envVar,
      created: meta.created ?? new Date().toISOString(),
    };
    const index = this.readIndex();
    index.secrets[ref] = full;
    this.writeIndex(index);
    return full;
  }

  /** True only when both the metadata and the Keychain item exist. */
  has(ref: string): boolean {
    return Boolean(this.readIndex().secrets[ref]) && this.backend.get(refAccount(ref)) !== null;
  }

  meta(ref: string): SecretMeta | undefined {
    return this.readIndex().secrets[ref];
  }

  delete(ref: string): boolean {
    const index = this.readIndex();
    const existed = Boolean(index.secrets[ref]);
    delete index.secrets[ref];
    this.writeIndex(index);
    return this.backend.delete(refAccount(ref)) || existed;
  }

  list(filter: { project?: string; service?: string } = {}): SecretMeta[] {
    return Object.values(this.readIndex().secrets).filter(
      (m) =>
        (!filter.project || m.project === filter.project) &&
        (!filter.service || m.service === filter.service),
    );
  }

  /** @internal Returns the secret value. Runner and proxy only. */
  resolve(ref: string): string | null {
    parseRef(ref);
    return this.backend.get(refAccount(ref));
  }

  private readIndex(): IndexFile {
    if (!existsSync(this.indexPath)) return { version: 1, secrets: {} };
    const parsed = JSON.parse(readFileSync(this.indexPath, "utf8")) as IndexFile;
    return { version: 1, secrets: parsed.secrets ?? {} };
  }

  private writeIndex(index: IndexFile): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const tmp = `${this.indexPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(index, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.indexPath);
    chmodSync(this.indexPath, 0o600);
  }
}
