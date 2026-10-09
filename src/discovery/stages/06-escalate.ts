import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiscoveryCtx } from "../types.js";
import { logger } from "../../obs/logger.js";

/**
 * Raise an intervention request and hand the live session to a person (§3.6).
 *
 * The control-transfer model, stated plainly:
 *   - Automation stops driving but does NOT tear down. The browser, its cookies
 *     and the half-filled form all survive — the operator continues the same
 *     session, not a reconstruction of it.
 *   - `driver.cedeControl()` flips the owner marker, so any automation call
 *     after this throws rather than racing the human.
 *   - The graph checkpoint holds the run state. Resuming is re-entering the
 *     graph on the same thread, with the human's actions appended to the trace.
 *
 * The intervention request is written as a file here. In production this is the
 * payload posted to an operator queue; the shape is what matters, and it must
 * carry enough for someone to act without reading the logs.
 */
export async function escalate(ctx: DiscoveryCtx): Promise<DiscoveryCtx> {
  const session = await ctx.driver.cedeControl();
  const reason = ctx.decision?.reason ?? ctx.failure?.code ?? "unknown";

  const request = {
    interventionId: `iv_${ctx.runId}_${ctx.stepIndex}`,
    raisedAt: new Date().toISOString(),
    goal: ctx.goal,
    tenantId: ctx.tenantId,
    atStep: ctx.stepIndex,
    reason,
    lastIntent: ctx.trace.at(-1)?.intent ?? null,
    currentUrl: ctx.observation?.url ?? null,
    currentTitle: ctx.observation?.title ?? null,
    screenshot: `step-${String(ctx.stepIndex).padStart(2, "0")}.png`,
    // How the operator takes control of this exact session.
    session: { sessionId: session.sessionId, connectUrl: session.connectUrl },
    resume: {
      // Re-entering the graph on this thread continues the run. `asNode` names
      // the node to pretend just completed, so the graph reopens at the right
      // place after the human has acted.
      // Must match the thread the graph actually ran on: graph.ts threadId() is
      // `${runId}:${capabilityId}`. Written out here because graph.ts imports
      // this file, and a resume pointed at a thread with no checkpoint finds nothing.
      threadId: `${ctx.runId}:${ctx.capabilityId ?? "discovery"}`,
      asNode: "act",
    },
  };

  const path = join(ctx.evidenceDir, "intervention.json");
  writeFileSync(path, JSON.stringify(request, null, 2));

  logger.warn(`[escalate] ${reason} at step ${ctx.stepIndex} — operator may take control at ${session.connectUrl}`);
  logger.warn(`[escalate] intervention request written to ${path}`);

  return {
    ...ctx,
    status: "escalated",
    escalation: {
      reason,
      atStep: ctx.stepIndex,
      sessionId: session.sessionId,
      connectUrl: session.connectUrl,
    },
  };
}
