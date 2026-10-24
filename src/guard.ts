import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Claude Code PreToolUse hook: blocks tool calls that would read a secret around Keysmith.
 * Deny rules match command prefixes; this also catches compound commands, paths in any
 * form and inline scripts. It's a guardrail, not a sandbox.
 */

export interface HookInput {
  tool_name?: string;
  tool_input?: { command?: string; file_path?: string; path?: string; pattern?: string };
}

export interface GuardDecision {
  block: boolean;
  reason?: string;
}

/** Folders where secrets or provider CLI credentials live (relative to home). */
const PROTECTED = [
  ".keysmith",
  ".config/stripe",
  ".config/resend",
  ".config/neonctl",
  ".supabase",
  "Library/Application Support/com.vercel.cli",
  ".wrangler",
  "Library/Preferences/.wrangler",
];

/** Commands that print a secret. Allowed only as `keysmith run -- …`, which redacts output. */
const PRINTS_SECRET: [RegExp, string][] = [
  [/^stripe\s+listen\b/, "`stripe listen` prints the webhook signing secret"],
  [/^stripe\s+config\s+--list\b/, "`stripe config --list` prints Stripe keys"],
  [/^supabase\s+projects\s+api-keys\b/, "`supabase projects api-keys` prints Supabase keys"],
  [/^vercel\s+env\s+pull\b/, "`vercel env pull` writes secrets to a plain file"],
  [/^neonctl\s+connection-string\b/, "`neonctl connection-string` prints the database password"],
];

/** Blocked anywhere in a command, even through keysmith run. */
const ALWAYS: [RegExp, string][] = [
  [
    /\bsecurity\s+(find-(generic|internet)-password|dump-keychain|export)\b/,
    "it reads the macOS Keychain",
  ],
  [/@napi-rs\/keyring|\bkeytar\b|\bkeyring\b.*\bkeysmith\b/, "it reads Keychain items in a script"],
];

const FIX =
  "Keysmith keeps keys out of the agent's reach. Use the keysmith tools (setup, connect, verify, request) or run the command as `keysmith run -- <cmd>`.";

function protectedPaths(): string[] {
  const home = homedir();
  return PROTECTED.flatMap((p) => [`${home}/${p}`, `~/${p}`, `$HOME/${p}`, `\${HOME}/${p}`]);
}

/** Split a shell command into simple commands (good enough for a guardrail). */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]|\$\(|`/)
    .map((s) => s.trim().replace(/^(sudo|exec|env(\s+\w+=\S+)*|command)\s+/, ""))
    .filter(Boolean);
}

export function guardDecision(input: HookInput): GuardDecision {
  const tool = input.tool_name ?? "";
  const ti = input.tool_input ?? {};
  const paths = protectedPaths();

  if (tool === "Bash" && ti.command) {
    const cmd = ti.command;
    for (const [re, why] of ALWAYS)
      if (re.test(cmd)) return { block: true, reason: `Blocked: ${why}. ${FIX}` };
    const hit = paths.find((p) => cmd.includes(p));
    if (hit)
      return {
        block: true,
        reason: `Blocked: the command touches ${hit}, where credentials live. ${FIX}`,
      };
    for (const seg of segments(cmd)) {
      if (/^keysmith\s+run\b/.test(seg)) continue;
      for (const [re, why] of PRINTS_SECRET)
        if (re.test(seg)) return { block: true, reason: `Blocked: ${why}. ${FIX}` };
    }
    return { block: false };
  }

  const target = ti.file_path ?? ti.path;
  if (target && ["Read", "Edit", "Write", "Grep", "Glob", "NotebookEdit"].includes(tool)) {
    const abs = resolve(target.replace(/^~(?=\/)/, homedir()));
    const hit = PROTECTED.map((p) => resolve(homedir(), p)).find(
      (p) => abs === p || abs.startsWith(`${p}/`),
    );
    if (hit) return { block: true, reason: `Blocked: ${hit} holds credentials. ${FIX}` };
  }
  return { block: false };
}

/** Entry point for `keysmith guard`: hook JSON on stdin, exit 2 with a reason to block. */
export async function runGuard(stdin: NodeJS.ReadableStream = process.stdin): Promise<number> {
  let raw = "";
  for await (const chunk of stdin) raw += String(chunk);
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    return 0; // Never break the session over a malformed hook payload.
  }
  const d = guardDecision(input);
  if (!d.block) return 0;
  process.stderr.write(`${d.reason}\n`);
  return 2;
}
