import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryKeychain } from "../src/vault/keychain.js";
import { Vault } from "../src/vault/index.js";

export function tmp(prefix = "keysmith-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function memoryVault(): { vault: Vault; keychain: MemoryKeychain; home: string } {
  const keychain = new MemoryKeychain();
  const home = tmp("keysmith-home-");
  return { vault: new Vault({ backend: keychain, home }), keychain, home };
}
