import type { DiscoveryCtx, TraceEntry } from "../types.js";
import { authorizeUrl } from "../../config/policy.js";
import { logger } from "../../obs/logger.js";

/**
 * Carry out the decided action, and record enough to compile a capability from
 * it later.
 *
 * Two properties worth noting.
 *
 * First, discovery is not a privileged path: the same allowlist that gates
 * replay gates this. A model proposing an out-of-policy navigation gets a
 * refusal written into the trace and another turn to choose differently, rather
 * than the run dying — being told "no" is information it can act on.
 *
 * Second, every element the model touches is *described* before it is acted on.
 * That description — role, accessible name, neighbouring label, field name,
 * table position — is what the compile stage turns into a durable locator
 * bundle. The ref the model used is discarded.
 */

/** Placeholders the model is told to type instead of real credentials. */
const SECRET_PLACEHOLDERS: Record<string, string> = {
  OPERATOR_USERNAME: "tenant.parabank.operator_user",
  OPERATOR_PASSWORD: "tenant.parabank.operator_password",
};

export async function act(ctx: DiscoveryCtx): Promise<DiscoveryCtx> {
  const decision = ctx.decision;
  const stepIndex = ctx.stepIndex;

  const entry: TraceEntry = {
    stepIndex,
    intent: decision?.intent ?? "(no intent)",
    action: decision?.action ?? {},
    observationBefore: {
      url: ctx.observation?.url ?? "",
      title: ctx.observation?.title ?? "",
    },
    outcome: "ok",
    at: new Date().toISOString(),
    proposedKey: actionKey((decision?.action ?? {}) as Record<string, unknown>),
  };

  const fail = (error: string): DiscoveryCtx => {
    logger.warn(`[act] step ${stepIndex} failed: ${error}`);
    return {
      ...ctx,
      stepIndex: stepIndex + 1,
      trace: [...ctx.trace, { ...entry, outcome: "failed", error }],
    };
  };

  const action = decision?.action as
    | { do: string; ref?: string; value?: string; into?: string; keys?: string; path?: string }
    | undefined;
  if (!action?.do) return fail("no usable action in the model's reply");

  // Loop guard. A model that cannot tell it has already filled a field will
  // fill it again, forever, until the step budget dies — and the budget is the
  // wrong place to catch that, because it burns the whole run. Refusing an
  // exact repeat and saying so is deterministic, cheap, and gives the model the
  // one piece of feedback it was missing.
  const proposedKey = actionKey(action);
  const repeated = ctx.trace.find((t) => t.outcome === "ok" && t.proposedKey === proposedKey);
  if (repeated) {
    return fail(
      `already performed at step ${repeated.stepIndex} — that action is done, choose the next one or say "done"`,
    );
  }

  // Recording a write flow means performing it. Refuse unless this session was
  // explicitly opted in — and say so in the trace, so the model gets a reason
  // rather than a silent dead end.
  if ((action as { irreversible?: boolean }).irreversible && !ctx.allowIrreversible) {
    return fail(
      "this action is irreversible and this recording session is not permitted to perform one" +
        " — re-run with --allow-irreversible in a test environment, or choose a reversible path",
    );
  }

  try {
    if (action.do === "navigate") {
      const gate = authorizeUrl(action.path ?? "", ctx.cfg.tenant);
      if (!gate.allowed) return fail(`policy refused ${action.path}: ${gate.code}`);
      await ctx.driver.navigate(action.path!);
      return commit(ctx, entry);
    }

    if (action.do === "press") {
      await ctx.driver.press(action.keys ?? "Enter");
      return commit(ctx, entry);
    }

    if (!action.ref) return fail(`action "${action.do}" needs a ref`);
    const resolution = await ctx.driver.resolveRef(action.ref);
    if (!resolution) return fail(`ref ${action.ref} did not resolve — it may be from a stale screen`);

    // Describe before acting: a click can navigate away, and then the element
    // is gone along with any chance of recording how to find it again.
    const harvested = await ctx.driver.describeTarget(resolution);
    entry.targeting = { strategy: "harvested", candidateIndex: 0, matchCount: 1 };
    entry.action = { ...action, harvested } as unknown as Record<string, unknown>;

    switch (action.do) {
      case "click":
        await ctx.driver.click(resolution);
        break;
      case "type": {
        const literal = action.value ?? "";
        const secretRef = SECRET_PLACEHOLDERS[literal];
        // The model types a placeholder; the real value is substituted here and
        // the trace records the reference, so no credential ever reaches the
        // transcript, the trace or the compiled artifact.
        const value = secretRef ? (process.env[envVar(secretRef)] ?? "") : literal;
        if (secretRef && !value) return fail(`secret ${secretRef} is not configured`);
        entry.action = { ...entry.action, value: secretRef ? { $secret: secretRef } : literal };
        await ctx.driver.type(resolution, value);
        break;
      }
      case "select":
        await ctx.driver.select(resolution, action.value ?? "");
        break;
      case "read": {
        const text = await ctx.driver.read(resolution, "text");
        entry.action = { ...entry.action, captured: text };
        logger.info(`[act] read "${action.into}" = ${text.slice(0, 40)}`);
        break;
      }
      default:
        return fail(`unsupported action "${action.do}"`);
    }

    return commit(ctx, entry);
  } catch (error) {
    return fail((error as Error).message);
  }
}

function commit(ctx: DiscoveryCtx, entry: TraceEntry): DiscoveryCtx {
  logger.info(`[act] step ${entry.stepIndex}: ${entry.intent}`);
  return { ...ctx, stepIndex: entry.stepIndex + 1, trace: [...ctx.trace, entry] };
}

function envVar(ref: string): string {
  return ref.replace(/[.\-]/g, "_").toUpperCase();
}

/**
 * Identity of an action *as the model proposed it* — same verb, same element,
 * same value.
 *
 * Computed before anything is rewritten, and stored on the trace entry, because
 * comparing against the stored action does not work: by then a typed credential
 * has become `{$secret: ...}` and no longer equals the placeholder the model
 * sent. That mismatch silently disabled the loop guard, and the model typed the
 * username into the same box twice.
 */
export function actionKey(a: Record<string, unknown>): string {
  return [
    a.do,
    a.ref ?? "",
    a.keys ?? "",
    a.path ?? "",
    a.into ?? "",
    typeof a.value === "string" ? a.value : "",
  ].join("|");
}
