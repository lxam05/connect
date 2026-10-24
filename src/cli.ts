#!/usr/bin/env node
import { Command } from "commander";
import { createContext } from "./app.js";
import { RECOMMENDED_DENY, runDoctor } from "./doctor.js";
import { log } from "./log.js";
import { accountLabel } from "./recipes/common.js";
import { runMcpServer } from "./mcp/server.js";
import type { ConnectResult, ConnectOptions } from "./recipes/types.js";
import { MissingSecretError, runWithSecrets } from "./runner.js";
import { describeSetupService } from "./setup.js";
import { runGuard } from "./guard.js";
import * as svc from "./service.js";
import { NativeKeychain } from "./vault/keychain.js";

const program = new Command();
program
  .name("keysmith")
  .description("Connect third-party services to a project without exposing secrets.")
  .version("0.1.0")
  .enablePositionalOptions()
  .option("--json", "machine-readable output");

const json = () => Boolean(program.opts().json);
const cliCtx = (options: ConnectOptions = {}) =>
  createContext({ options: { wait: true, ...options }, progress: (m) => log.info(`• ${m}`) });

function printResult(r: ConnectResult): void {
  if (json()) return log.out(JSON.stringify(r, null, 2));
  const icon = {
    connected: "✓",
    already_connected: "✓",
    repaired: "✓",
    action_required: "→",
    failed: "✗",
  }[r.outcome];
  log.out(`${icon} ${r.message}`);
  if (r.envVars?.length) log.out(`  .env: ${r.envVars.join(", ")}`);
  for (const s of r.humanSteps ?? []) log.out(`  next: ${s}`);
  for (const w of r.warnings ?? []) log.out(`  note: ${w}`);
  if (r.outcome === "failed") process.exitCode = 1;
}

program
  .command("list")
  .description("list services Keysmith can connect")
  .action(() => {
    const services = svc.listServices();
    if (json()) return log.out(JSON.stringify(services, null, 2));
    const width = Math.max(...services.map((s) => s.id.length));
    for (const s of services) {
      log.out(
        `${s.id.padEnd(width)} ${s.displayName} (${s.support}) — ${s.envVars.map((v) => v.name).join(", ")}`,
      );
      for (const h of s.humanSteps) log.out(`${" ".repeat(width + 1)}· ${h}`);
    }
  });

program
  .command("connect")
  .argument("<service...>", "service id(s), e.g. stripe resend")
  .option("--tier <tier>", "auto | cli | capture", "auto")
  .option("--force", "replace an existing connection, e.g. to switch accounts")
  .option("--project <id>", "provider project or account to use when there are several")
  .description("connect services to this project")
  .action(
    async (
      services: string[],
      opts: { tier: ConnectOptions["tier"]; force?: boolean; project?: string },
    ) => {
      for (const s of services)
        printResult(
          await svc.connect(
            cliCtx({ tier: opts.tier, force: opts.force, project: opts.project }),
            s,
          ),
        );
    },
  );

program
  .command("scan")
  .description("work out which API keys this project needs (no changes)")
  .action(async () => {
    const r = await svc.scan(cliCtx());
    if (json()) return log.out(JSON.stringify(r, null, 2));
    log.out(`project ${r.project} (${r.root})`);
    if (!r.services.length && !r.unmatched.length)
      log.out("  No API keys needed that Keysmith can see.");
    for (const s of r.services) {
      const where = s.account ? ` · ${accountLabel(s.account, s.accountName)}` : "";
      log.out(`  ${s.state === "connected" ? "✓" : "·"} ${s.displayName} (${s.state}${where})`);
      log.out(`      ${s.reasons.join("; ")}`);
    }
    for (const u of r.unmatched)
      log.out(`  ${u.stored ? "✓" : "·"} ${u.name} (no recipe: stored as a custom secret)`);
    if (r.plaintext.length)
      log.out(
        `  ! Plain-text secrets in env files: ${r.plaintext.join(", ")} (setup moves them to the Keychain)`,
      );
    if (r.vercel) log.out("  · Linked to Vercel: setup imports its development env vars");
    if (r.devScript.present && !r.devScript.usesKeysmith)
      log.out("  · The dev script doesn't run through keysmith yet (setup fixes this)");
    if (r.truncated) log.out("  note: stopped scanning after 5,000 source files");
    log.out("Run `keysmith setup` to connect everything.");
  });

program
  .command("setup")
  .option("--no-dev-script", "leave package.json's dev script alone")
  .option("--project <id>", "provider project or account to use when there are several")
  .description("give this project every API key it needs: scan, connect, verify")
  .action(async (opts: { devScript: boolean; project?: string }) => {
    const r = await svc.setup(cliCtx({ project: opts.project }), { devScript: opts.devScript });
    if (json()) return log.out(JSON.stringify(r, null, 2));
    if (r.imported.length) log.out(`• Moved into the Keychain: ${r.imported.join(", ")}`);
    for (const s of r.services) {
      log.out(describeSetupService(s));
      for (const w of s.warnings ?? []) log.out(`  note: ${w}`);
    }
    if (r.devScript.changed) log.out(`• dev script: ${r.devScript.command}`);
    if (r.devScript.note) log.out(`• ${r.devScript.note}`);
    for (const h of r.humanSteps) log.out(`  next: ${h}`);
    log.out(r.summary);
    if (!r.done) process.exitCode = 1;
  });

program
  .command("add")
  .argument("<var...>", "env var name(s), e.g. FOO_API_KEY")
  .option("--url <url>", "page to open first, where the key is created")
  .option("--force", "replace a stored value")
  .description("store any other secret via the hidden dialog")
  .action(async (vars: string[], opts: { url?: string; force?: boolean }) => {
    printResult(await svc.addSecret(cliCtx(), vars, opts));
  });

program
  .command("status")
  .option("--all", "include services that aren't connected")
  .description("show connected services (no values)")
  .action(async (opts: { all?: boolean }) => {
    const st = await svc.status(cliCtx());
    if (json()) return log.out(JSON.stringify(st, null, 2));
    log.out(`project ${st.project} (${st.root})`);
    const shown = st.services.filter((s) => opts.all || s.state !== "not_connected");
    if (!shown.length)
      log.out("  Nothing connected yet. Run `keysmith scan` to see what this project needs.");
    const width = Math.max(0, ...shown.map((s) => s.service.length));
    for (const s of shown) {
      const bits: string[] = [s.state];
      if (s.mode) bits.push(s.modeLabel ?? `${s.mode} mode`);
      if (s.account) bits.push(`account ${accountLabel(s.account, s.accountName)}`);
      if (s.expires)
        bits.push(`expires ${s.expires.slice(0, 10)}${s.expiringSoon ? " (soon!)" : ""}`);
      if (s.missing?.length) bits.push(`missing ${s.missing.join(", ")}`);
      log.out(`  ${s.service.padEnd(width)} ${bits.join(" · ")}`);
    }
  });

program
  .command("verify")
  .argument("[service...]", "service id(s); default: all connected")
  .description("prove keys work without revealing them")
  .action(async (services: string[]) => {
    const ctx = cliCtx();
    const ids = services.length
      ? services
      : (await svc.status(ctx)).services
          .filter((s) => s.state !== "not_connected")
          .map((s) => s.service);
    if (!ids.length) return log.out("Nothing connected yet. Try: keysmith connect stripe");
    for (const id of ids) {
      const r = await svc.verify(ctx, id);
      if (json()) log.out(JSON.stringify(r));
      else {
        log.out(`${r.ok ? (r.unverified ? "·" : "✓") : "✗"} ${id}: ${r.message}`);
        for (const w of r.warnings ?? []) log.out(`  warning: ${w}`);
      }
      if (!r.ok) process.exitCode = 1;
    }
  });

program
  .command("rotate")
  .argument("<service>")
  .option("-y, --yes", "skip the confirmation prompt")
  .description("replace a service's key and revoke the old one")
  .action(async (service: string, opts: { yes?: boolean }) => {
    if (!opts.yes) {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const answer = await rl.question(
        `Rotate the ${service} key? Running apps must restart. [y/N] `,
      );
      rl.close();
      if (!/^y(es)?$/i.test(answer.trim())) return log.out("Canceled.");
    }
    printResult(await svc.rotate(cliCtx(), service));
  });

program
  .command("run")
  .argument("<command...>")
  .description("run a command with real secrets injected and output redacted")
  .allowUnknownOption()
  .passThroughOptions()
  .action(async ([command, ...args]: string[]) => {
    const ctx = cliCtx();
    try {
      process.exitCode = await runWithSecrets({
        project: ctx.project,
        vault: ctx.vault,
        command: command!,
        args,
      });
    } catch (e) {
      if (e instanceof MissingSecretError) {
        log.error(e.message);
        process.exitCode = 1;
      } else throw e;
    }
  });

program
  .command("doctor")
  .option("--fix", "add missing agent deny rules and .gitignore entries")
  .description("check that secrets are protected from agents and git")
  .action(async (opts: { fix?: boolean }) => {
    const ctx = cliCtx();
    const checks = await runDoctor(ctx.project, ctx.sys, new NativeKeychain(), {
      fix: opts.fix,
    });
    if (json())
      return log.out(JSON.stringify({ checks, recommendedDeny: RECOMMENDED_DENY }, null, 2));
    for (const c of checks) log.out(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
    if (checks.some((c) => !c.ok)) process.exitCode = 1;
  });

program
  .command("guard")
  .description("Claude Code PreToolUse hook: block tool calls that would read secrets")
  .action(async () => {
    process.exitCode = await runGuard();
  });

program
  .command("mcp")
  .description("run the MCP server over stdio")
  .action(async () => {
    await runMcpServer();
  });

program.parseAsync().catch((e: unknown) => {
  log.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
