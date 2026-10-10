#!/usr/bin/env node

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "./config/config.js";
import { authorizeCapability, authorizeUrl } from "./config/policy.js";
import { createAiProvider } from "./providers/aiProvider.js";
import { PlaywrightDriver } from "./surface/playwrightDriver.js";
import { runDiscovery } from "./discovery/graph.js";
import { compileArtifact } from "./discovery/stages/05-compile.js";
import type { DiscoveryCtx } from "./discovery/types.js";
import { replay } from "./replay/engine.js";
import { Capability } from "./artifact/index.js";
import { OperatorConsole } from "./escalation/console.js";
import { logger } from "./obs/logger.js";

/**
 * `key=value` pairs from --param. A bare `account_id` used to slice to
 * `{account_i: "account_id"}` with no error, so the real parameter then went
 * missing under a misleading name.
 */
function parseParams(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of pairs) {
    const i = kv.indexOf("=");
    if (i < 1) throw new Error(`--param expects key=value, got "${kv}"`);
    out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

const program = new Command()
  .name("interface-agent")
  .description("Record a UI flow once with an LLM, replay it deterministically forever");

program
  .command("discover")
  .description("Drive an app with an LLM until a goal is met, then emit a capability artifact")
  .requiredOption("--goal <text>", "what to accomplish, in natural language")
  .option("--entry <path>", "entry point path", "/parabank/index.htm")
  .option("--capability-id <id>", "id for the emitted artifact", "discovered_capability")
  .option(
    "--param <kv...>",
    "values to generalise into typed parameters, as key=value (e.g. account_id=12345)",
    [],
  )
  .option(
    "--allow-irreversible",
    "permit this recording to perform actions that cannot be undone (test environments only)",
  )
  .action(async (opts) => {
    assertNotPathMangled("--entry", opts.entry);
    const cfg = loadConfig();
    const runId = `run_${Date.now().toString(36)}`;

    const ctx: DiscoveryCtx = {
      runId,
      goal: opts.goal,
      entryPath: opts.entry,
      tenantId: cfg.tenant.tenantId,
      cfg,
      provider: createAiProvider(cfg),
      driver: new PlaywrightDriver({
        headless: cfg.headless,
        baseUrl: cfg.tenant.baseUrl,
        allowNavigation: (url) => authorizeUrl(url, cfg.tenant).allowed,
        liveFrameFile: process.env.UIFLOW_FRAME_FILE || undefined,
      }),
      stepIndex: 0,
      status: "running",
      trace: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 },
      usageByStage: {},
      capabilityId: opts.capabilityId,
      allowIrreversible: Boolean(opts.allowIrreversible),
      parameterValues: parseParams(opts.param as string[]),
      evidenceDir: join(cfg.runsDir, runId),
    };

    try {
      const final = await runDiscovery(ctx, opts.capabilityId);
      logger.info(`[discover] finished: ${final.status} after ${final.stepIndex} steps`);
      logger.info(`[discover] evidence in ${final.evidenceDir}`);
      // A script or CI job reads the exit code. Discovery that gave up or
      // escalated produced no capability, and must not look like success.
      if (final.status !== "succeeded") process.exitCode = 1;
    } finally {
      await ctx.driver.close();
    }
  });

/**
 * Recompile a capability from a recorded trace. Discovery is the expensive half
 * of the system; changing how a trace is distilled should not cost a run.
 */
program
  .command("recompile")
  .description("Rebuild a capability artifact from a saved discovery trace (no model, no browser)")
  .requiredOption("--run <dir>", "run directory containing trace.json and run-meta.json")
  .action(async (opts) => {
    const cfg = loadConfig();
    const meta = JSON.parse(readFileSync(join(opts.run, "run-meta.json"), "utf8"));
    const trace = JSON.parse(readFileSync(join(opts.run, "trace.json"), "utf8"));

    const ctx = {
      ...meta,
      cfg,
      trace,
      evidenceDir: opts.run,
      observation: { title: meta.finalTitle, url: meta.finalUrl, tree: "" },
      // compile only reads .surface and .name/.model off these.
      driver: { surface: meta.surface },
      provider: { name: String(meta.model).split(":")[0], model: String(meta.model).split(":")[1] },
    } as unknown as DiscoveryCtx;

    const out = await compileArtifact(ctx);
    logger.info(`[recompile] ${out.status}`);
  });

program
  .command("replay")
  .description("Execute a saved capability artifact with no model in the loop")
  .requiredOption("--artifact <path>", "path to the capability JSON")
  .option("--param <kv...>", "input parameters as key=value", [])
  .option("--operator [port]", "start an operator console so escalations suspend instead of failing")
  .option(
    "--confirm-irreversible",
    "stand in for the human decision an irreversible step requires (test use)",
  )
  .action(async (opts) => {
    const cfg = loadConfig();
    const capability = Capability.parse(JSON.parse(readFileSync(opts.artifact, "utf8")));

    const authorized = authorizeCapability(capability, cfg.tenant);
    if (!authorized.allowed) {
      logger.error(`[replay] refused: ${authorized.code} — ${authorized.reason}`);
      process.exitCode = 1;
      return;
    }

    const params = parseParams(opts.param as string[]);

    const driver = new PlaywrightDriver({
      headless: cfg.headless,
      baseUrl: cfg.tenant.baseUrl,
      allowNavigation: (url) => authorizeUrl(url, cfg.tenant).allowed,
      liveFrameFile: process.env.UIFLOW_FRAME_FILE || undefined,
    });
    const evidenceDir = join(cfg.runsDir, `rp_${Date.now().toString(36)}`);
    const consolePort = opts.operator === true ? 8790 : Number(opts.operator);
    if (opts.operator && !(Number.isInteger(consolePort) && consolePort > 0 && consolePort < 65536)) {
      throw new Error(`--operator expects a port number, got "${opts.operator}"`);
    }
    const operator = opts.operator ? new OperatorConsole({ port: consolePort, evidenceDir }) : null;

    try {
      if (operator) {
        mkdirSync(evidenceDir, { recursive: true });
        await operator.start();
      }
      await driver.start();
      const result = await replay({
        capability,
        params,
        cfg,
        driver,
        evidenceDir,
        humanConfirmed: Boolean(opts.confirmIrreversible),
        // With a console attached an escalation suspends the run and waits for
        // a person; without one it stays terminal and the caller handles it.
        onEscalation: operator ? (req, d) => operator.raise(req, d) : undefined,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      // success and a declared business outcome are both answers the caller
      // asked for. A failure or an escalation is not, so say so in the exit code.
      if (result.status === "failed" || result.status === "escalated") process.exitCode = 1;
    } finally {
      await operator?.stop();
      await driver.close();
    }
  });

program.parseAsync(process.argv).catch((error) => {
  logger.error((error as Error).message);
  process.exitCode = 1;
});


/**
 * Git Bash / MSYS on Windows rewrites an argument that looks like a Unix
 * absolute path into a Windows one, so `--entry /parabank/index.htm` arrives as
 * `C:/Program Files/Git/parabank/index.htm`. That then parses as a URL with
 * scheme `c:`, which has an opaque origin, and the allowlist correctly refuses
 * it — with a message that gives no hint of the real cause.
 *
 * Catching it here turns twenty minutes of confusion into one line.
 */
function assertNotPathMangled(flag: string, value: string | undefined): void {
  if (value && /^[A-Za-z]:[\/]/.test(value)) {
    throw new Error(
      `${flag} was rewritten to an absolute Windows path ("${value}") — this is Git Bash/MSYS ` +
        `path conversion, not your input. Re-run with MSYS_NO_PATHCONV=1, use a double slash ` +
        `(${flag} //parabank/index.htm), or omit ${flag} to take the default.`,
    );
  }
}
