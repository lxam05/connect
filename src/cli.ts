#!/usr/bin/env node
import { Command } from "commander";
import { createContext } from "./app.js";
import { RECOMMENDED_DENY, runDoctor } from "./doctor.js";
import { log } from "./log.js";
import { accountLabel } from "./recipes/common.js";
import { runMcpServer } from "./mcp/server.js";
import type { ConnectResult, ConnectOptions } from "./recipes/types.js";
import { MissingSecretError, runWithSecrets } from "./runner.js";
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
        `${s.id.padEnd(width)} ${s.displayName} — ${s.envVars.map((v) => v.name).join(", ")}`,
      );
      for (const h of s.humanSteps) log.out(`${" ".repeat(width + 1)}· ${h}`);
    }
  });

program
  .command("connect")
  .argument("<service...>", "service id(s), e.g. stripe resend")
  .option("--tier <tier>", "auto | cli | capture", "auto")
  .option("--force", "replace an existing Stripe connection, e.g. to switch accounts")
  .description("connect services to this project")
  .action(async (services: string[], opts: { tier: ConnectOptions["tier"]; force?: boolean }) => {
    for (const s of services)
      printResult(await svc.connect(cliCtx({ tier: opts.tier, force: opts.force }), s));
  });

program
  .command("status")
  .description("show connected services (no values)")
  .action(async () => {
    const st = await svc.status(cliCtx());
    if (json()) return log.out(JSON.stringify(st, null, 2));
    log.out(`project ${st.project} (${st.root})`);
    const width = Math.max(...st.services.map((s) => s.service.length));
    for (const s of st.services) {
      const bits: string[] = [s.state];
      if (s.mode) bits.push(`${s.mode} mode`);
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
        log.out(`${r.ok ? "✓" : "✗"} ${id}: ${r.message}`);
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
  .command("mcp")
  .description("run the MCP server over stdio")
  .action(async () => {
    await runMcpServer();
  });

program.parseAsync().catch((e: unknown) => {
  log.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
