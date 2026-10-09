import { z } from "zod";
import type { DiscoveryCtx } from "../types.js";
import { mergeUsage } from "../../providers/aiProvider.js";
import { logger } from "../../obs/logger.js";

/**
 * The one stage that talks to a model (§3.1).
 *
 * Everything else in this system is deterministic. Keeping the model confined
 * to a single node is what makes "replay without the LLM in the decision loop"
 * structurally true rather than a claim — there is exactly one place to remove.
 *
 * The model chooses *what to do next* and *which element to do it to*, by ref.
 * It never authors a locator: refs come from the tree it was just shown, so it
 * cannot invent one that resolves, and the durable targeting is derived from
 * the element afterwards (see harvest.ts).
 */

export const Decision = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("act"),
    intent: z.string().min(1),
    action: z.discriminatedUnion("do", [
      z.object({ do: z.literal("click"), ref: z.string() }),
      z.object({ do: z.literal("type"), ref: z.string(), value: z.string() }),
      z.object({ do: z.literal("select"), ref: z.string(), value: z.string() }),
      z.object({ do: z.literal("read"), ref: z.string(), into: z.string() }),
      z.object({ do: z.literal("press"), keys: z.string() }),
      z.object({ do: z.literal("navigate"), path: z.string() }),
    ]),
    /**
     * The model's judgement that this action cannot be undone from the UI.
     * Asking it to classify is the right division of labour: judging what an
     * action *means* is a language problem, and enforcing the consequence is a
     * deterministic one. The flag is recorded, compiled into `risk:
     * "irreversible"`, and from then on every replay gates on it.
     */
    irreversible: z.boolean().default(false),
  }),
  z.object({ kind: z.literal("done"), intent: z.string().min(1) }),
  z.object({ kind: z.literal("stuck"), reason: z.string().min(1) }),
]);
export type Decision = z.infer<typeof Decision>;

/**
 * Recording a write flow means performing it. That is safe only where it is
 * deliberate: an authorised person, a test environment, explicit opt-in. The
 * guardrail that protects production is on replay, where the compiled step
 * carries risk: "irreversible" and is gated every single time.
 */
export function decideSystemPrompt(allowIrreversible: boolean): string {
  return DECIDE_SYSTEM_PROMPT.replace(
    "IRREVERSIBLE_POLICY",
    allowIrreversible
      ? "You ARE permitted to perform such an action for this recording — proceed, and mark it."
      : "You are NOT permitted to perform such an action. Return \"stuck\" and let a human decide.",
  );
}

const DECIDE_SYSTEM_PROMPT = `
You operate a back-office banking application on behalf of a human operator.
You are given a goal, the accessibility tree of the current screen, and the
actions taken so far. Choose the single next action.

Every interactive element in the tree carries a handle like [ref=e34]. Refer to
elements ONLY by that ref. Do not invent CSS selectors or describe elements in
prose — the ref is how you point at something.

Respond with a JSON object and nothing else. Exactly one of:

  {"kind":"act","intent":"<why, one sentence>","action":{"do":"click","ref":"e34"}}
  {"kind":"act","intent":"...","action":{"do":"type","ref":"e34","value":"..."}}
  {"kind":"act","intent":"...","action":{"do":"select","ref":"e34","value":"..."}}
  {"kind":"act","intent":"...","action":{"do":"read","ref":"e34","into":"balance_text"}}
  {"kind":"act","intent":"...","action":{"do":"press","keys":"Enter"}}
  {"kind":"act","intent":"...","action":{"do":"navigate","path":"/some/path"}}
  {"kind":"done","intent":"<what on this screen confirms the goal is met>"}
  {"kind":"stuck","reason":"<what you cannot determine>"}

Rules:
- When the goal requires reading a value, use "read" and give it a snake_case
  name in "into". That value becomes the capability's output.
- When a credential is required, type the literal placeholder OPERATOR_USERNAME
  or OPERATOR_PASSWORD. Never invent credentials; the real values are injected
  outside your view and will replace the placeholder.
- Mark any action that cannot be undone from the UI — moving money, creating or
  closing an account, submitting a payment — with "irreversible": true on the
  action. Judge it by consequence, not by the wording of the button.
  IRREVERSIBLE_POLICY
- An error, a permission denial or a "not found" result is information. Report
  it with "done" or "stuck" rather than retrying blindly.
- Say "done" as soon as the goal is satisfied. Do not keep exploring.
`.trim();

function buildPrompt(ctx: DiscoveryCtx): string {
  const history = ctx.trace
    .slice(-8)
    .map((t) => {
      // Feeding captured values back is what stops the loop: without it the
      // model cannot tell a successful read from one that never happened, so
      // it reads the same cell over and over until the step budget dies.
      const captured = (t.action as { captured?: string; into?: string }).captured;
      const suffix = captured !== undefined ? ` (captured ${(t.action as { into?: string }).into} = "${captured}")` : "";
      return `${t.stepIndex}. ${t.intent} -> ${t.outcome}${t.error ? ` (${t.error})` : suffix}`;
    })
    .join("\n");

  return [
    `GOAL: ${ctx.goal}`,
    `STEP: ${ctx.stepIndex} of ${ctx.cfg.maxSteps}`,
    `URL: ${ctx.observation?.url ?? "(none)"}`,
    ``,
    `ACTIONS SO FAR:`,
    history || "(none yet)",
    ``,
    `CURRENT SCREEN (accessibility tree):`,
    ctx.observation?.tree ?? "(no observation)",
  ].join("\n");
}

/** Models wrap JSON in prose or fences however the mood takes them. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`no JSON object in model reply: ${text.slice(0, 200)}`);
  return JSON.parse(body.slice(start, end + 1));
}

export async function decide(ctx: DiscoveryCtx): Promise<DiscoveryCtx> {
  const prompt = buildPrompt(ctx);

  // Vision is opt-in per provider; the tree is always present, so a text-only
  // provider degrades rather than failing.
  const images =
    ctx.provider.supportsVision && ctx.observation?.screenshot ? [ctx.observation.screenshot] : [];

  const { text, usage } = await ctx.provider.execute(prompt, {
    system: decideSystemPrompt(ctx.allowIrreversible ?? false),
    images,
  });

  let decision: Decision;
  try {
    decision = Decision.parse(extractJson(text));
  } catch (error) {
    // A malformed reply is not a dead end on its own: record it and let the
    // next turn try again, until the step budget runs out.
    logger.warn(`[decide] unusable reply (${(error as Error).message})`);
    return {
      ...ctx,
      usage: mergeUsage(ctx.usage, usage),
      decision: { kind: "act", intent: "retry after an unparseable reply", action: undefined },
    };
  }

  logger.info(`[decide] ${decision.kind}: ${decision.kind === "stuck" ? decision.reason : decision.intent}`);

  return {
    ...ctx,
    usage: mergeUsage(ctx.usage, usage),
    decision:
      decision.kind === "act"
        ? {
            kind: "act",
            intent: decision.intent,
            // Carried alongside the verb so `act` can gate on it and `compile`
            // can turn it into the step's risk class.
            action: { ...decision.action, irreversible: decision.irreversible } as Record<string, unknown>,
          }
        : decision.kind === "done"
          ? { kind: "done", intent: decision.intent }
          : { kind: "stuck", intent: "cannot proceed", reason: decision.reason },
  };
}
