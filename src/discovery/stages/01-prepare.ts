import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DiscoveryCtx } from "../types.js";
import { authorizeUrl } from "../../config/policy.js";
import { initFileLog, logger } from "../../obs/logger.js";
import { ensureProxyRunning } from "../../providers/headroomProxy.js";

/**
 * Start the session and prove the entry point is in policy before anything is
 * driven. The allowlist check happens here, not at first navigation: a goal
 * pointing outside the tenant's grant should fail immediately and cheaply.
 */
export async function prepare(ctx: DiscoveryCtx): Promise<DiscoveryCtx> {
  mkdirSync(ctx.evidenceDir, { recursive: true });
  initFileLog(join(ctx.evidenceDir, "run.jsonl"));

  logger.info(`[prepare] run ${ctx.runId} | goal: ${ctx.goal}`);
  logger.info(`[prepare] provider ${ctx.provider.name} (${ctx.provider.model})`);

  await ensureProxyRunning();

  const decision = authorizeUrl(ctx.entryPath, ctx.cfg.tenant);
  if (!decision.allowed) {
    logger.error(`[prepare] entry point refused: ${decision.code} — ${decision.reason}`);
    return { ...ctx, status: "failed", failure: { code: decision.code, message: decision.reason } };
  }

  const session = await ctx.driver.start();
  logger.info(`[prepare] session ${session.sessionId} live at ${session.connectUrl}`);

  await ctx.driver.navigate(ctx.entryPath);
  return { ...ctx, status: "running", stepIndex: 0 };
}
