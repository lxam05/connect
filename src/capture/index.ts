import { execFile } from "node:child_process";
import type { System } from "../sys.js";

export interface CaptureRequest {
  /** Dialog title, e.g. "Keysmith — Resend". */
  title: string;
  /** What the user should paste. Shown in the dialog. */
  message: string;
  /** Provider page to open first (where the key is created). */
  url?: string;
  /** Returns an error message for an invalid value, or null if it's acceptable. */
  validate(value: string): string | null;
  attempts?: number;
}

export type CaptureResult =
  | { ok: true; value: string }
  | { ok: false; reason: "canceled" | "invalid" | "unavailable"; message: string };

/** Collects a secret from the human without passing it through the agent or terminal. */
export interface SecretCapture {
  capture(req: CaptureRequest): Promise<CaptureResult>;
}

/**
 * AppleScript run as `on run argv` so message/title are passed as data, never
 * interpolated into the script.
 */
const DIALOG_SCRIPT = [
  "on run argv",
  "set msg to item 1 of argv",
  "set ttl to item 2 of argv",
  'set r to display dialog msg default answer "" with hidden answer with title ttl buttons {"Cancel", "Save to Keychain"} default button "Save to Keychain" cancel button "Cancel" with icon note',
  "return text returned of r",
  "end run",
];

export type DialogResult = { canceled: boolean; value: string; error?: string };
export type ShowDialog = (message: string, title: string) => Promise<DialogResult>;

function showDialog(message: string, title: string): Promise<DialogResult> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      [...DIALOG_SCRIPT.flatMap((l) => ["-e", l]), message, title],
      { timeout: 10 * 60_000 },
      (err, stdout, stderr) => {
        if (err) {
          // -128 is "User canceled". Never include stdout in errors.
          const canceled = /-128/.test(String(stderr));
          resolve({ canceled, value: "", error: canceled ? undefined : String(stderr).trim() });
          return;
        }
        resolve({ canceled: false, value: String(stdout).replace(/\r?\n$/, "") });
      },
    );
  });
}

/** Native macOS dialog with hidden input. Dialog → this process → Keychain. */
export class DialogCapture implements SecretCapture {
  constructor(
    private readonly sys: System,
    private readonly dialog: ShowDialog = showDialog,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async capture(req: CaptureRequest): Promise<CaptureResult> {
    if (this.platform !== "darwin") {
      return { ok: false, reason: "unavailable", message: "Secure capture needs macOS." };
    }
    if (req.url) await this.sys.open(req.url);
    const attempts = req.attempts ?? 3;
    let message = req.message;
    for (let i = 0; i < attempts; i++) {
      const r = await this.dialog(message, req.title);
      if (r.canceled)
        return {
          ok: false,
          reason: "canceled",
          message: "The user canceled the dialog. Nothing was saved.",
        };
      if (r.error)
        return { ok: false, reason: "unavailable", message: `Dialog failed: ${r.error}` };
      const value = r.value.trim();
      const problem = req.validate(value);
      if (!problem) return { ok: true, value };
      message = `${problem}\n\n${req.message}`;
    }
    return {
      ok: false,
      reason: "invalid",
      message: `No valid value was entered after ${attempts} tries. Nothing was saved, and your current key (if any) is unchanged.`,
    };
  }
}

/** Build a validator from accepted prefixes. */
export function prefixValidator(prefixes: string[], label: string) {
  return (value: string): string | null => {
    if (!value) return "Nothing was pasted.";
    if (/\s/.test(value)) return "The value contains spaces — paste only the key.";
    if (!prefixes.some((p) => value.startsWith(p))) {
      return `That doesn't look like ${label} (expected it to start with ${prefixes.join(" or ")}).`;
    }
    if (value.length < 20) return "That key looks too short.";
    return null;
  };
}
