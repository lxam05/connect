import { Entry } from "@napi-rs/keyring";

export const KEYCHAIN_SERVICE = "keysmith";

export interface KeychainBackend {
  get(account: string): string | null;
  set(account: string, value: string): void;
  delete(account: string): boolean;
}

/** macOS Keychain via @napi-rs/keyring (generic password, service "keysmith"). */
export class NativeKeychain implements KeychainBackend {
  get(account: string): string | null {
    return new Entry(KEYCHAIN_SERVICE, account).getPassword() ?? null;
  }
  set(account: string, value: string): void {
    new Entry(KEYCHAIN_SERVICE, account).setPassword(value);
  }
  delete(account: string): boolean {
    try {
      return new Entry(KEYCHAIN_SERVICE, account).deletePassword();
    } catch {
      return false;
    }
  }
}

/** In-memory backend for tests. */
export class MemoryKeychain implements KeychainBackend {
  readonly items = new Map<string, string>();
  get(account: string): string | null {
    return this.items.get(account) ?? null;
  }
  set(account: string, value: string): void {
    this.items.set(account, value);
  }
  delete(account: string): boolean {
    return this.items.delete(account);
  }
}
