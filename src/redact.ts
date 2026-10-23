import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export const REDACTED = "[keysmith:redacted]";

/** Values shorter than this are not treated as secrets (they would redact ordinary text). */
const MIN_SECRET_LENGTH = 8;

/**
 * Well-known secret shapes, redacted even when the exact value is unknown to us
 * (e.g. a brand-new key returned by a provider API).
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{10,}\b/g,
  /\bwhsec_[A-Za-z0-9]{10,}\b/g,
  /\bre_[A-Za-z0-9_]{16,}\b/g,
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class Redactor {
  private secrets: string[] = [];
  private matcher: RegExp | null = null;

  constructor(
    secrets: Iterable<string> = [],
    private readonly usePatterns = true,
  ) {
    for (const s of secrets) this.add(s);
  }

  add(secret: string): void {
    if (secret.length < MIN_SECRET_LENGTH || this.secrets.includes(secret)) return;
    this.secrets.push(secret);
    // Longest first so a secret that contains another is redacted whole.
    this.secrets.sort((a, b) => b.length - a.length);
    this.matcher = new RegExp(this.secrets.map(escapeRegExp).join("|"), "g");
  }

  get size(): number {
    return this.secrets.length;
  }

  redact(text: string): string {
    let out = this.matcher ? text.replace(this.matcher, REDACTED) : text;
    if (this.usePatterns) for (const p of SECRET_PATTERNS) out = out.replace(p, REDACTED);
    return out;
  }

  /**
   * Split `text` into a part that is safe to emit now and a tail that might be the
   * beginning of a secret continued in the next chunk.
   */
  splitSafe(text: string): { emit: string; carry: string } {
    if (!this.matcher) return { emit: this.redact(text), carry: "" };
    let emitted = "";
    let last = 0;
    this.matcher.lastIndex = 0;
    for (let m = this.matcher.exec(text); m; m = this.matcher.exec(text)) {
      emitted += text.slice(last, m.index) + REDACTED;
      last = m.index + m[0].length;
    }
    const tail = text.slice(last);
    const longest = this.secrets[0]!.length;
    let cut = tail.length;
    for (let i = Math.max(0, tail.length - longest + 1); i < tail.length; i++) {
      const suffix = tail.slice(i);
      if (this.secrets.some((s) => s.length > suffix.length && s.startsWith(suffix))) {
        cut = i;
        break;
      }
    }
    // Pattern redaction runs on emitted text only; a pattern split across chunks is
    // caught by the exact matcher for every secret we know about.
    return { emit: this.redactPatterns(emitted + tail.slice(0, cut)), carry: tail.slice(cut) };
  }

  private redactPatterns(text: string): string {
    if (!this.usePatterns) return text;
    let out = text;
    for (const p of SECRET_PATTERNS) out = out.replace(p, REDACTED);
    return out;
  }
}

/**
 * A Transform that redacts every known secret, even when a secret is split
 * across chunk boundaries. Holds back only the shortest possible tail.
 */
export function createRedactStream(redactor: Redactor): Transform {
  const decoder = new StringDecoder("utf8");
  let carry = "";
  return new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      const { emit, carry: next } = redactor.splitSafe(carry + decoder.write(chunk));
      carry = next;
      cb(null, emit);
    },
    flush(cb: TransformCallback) {
      cb(null, redactor.redact(carry + decoder.end()));
    },
  });
}

/** Recursively redact fields whose names indicate a secret, plus known values. */
const SECRET_FIELD = /^(secret|token|api_key|apikey|key|client_secret|password|private_key)$/i;

export function redactJson(value: unknown, redactor: Redactor): unknown {
  if (typeof value === "string") return redactor.redact(value);
  if (Array.isArray(value)) return value.map((v) => redactJson(v, redactor));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] =
        SECRET_FIELD.test(k) && typeof v === "string" && v ? REDACTED : redactJson(v, redactor);
    }
    return out;
  }
  return value;
}
