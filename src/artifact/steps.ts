import { z } from "zod";
import { Assertion } from "./conditions.js";
import { Locator } from "./locator.js";
import { Id, Sensitivity, ValueExpr } from "./values.js";

/**
 * Actions and steps.
 *
 * Actions are deliberately *surface-neutral verbs* (click / type / read), not
 * Playwright calls. A desktop UIA driver implements the same verb set; only the
 * locator candidate kinds differ per surface. That is the seam between "how we
 * perceive and act on a surface" and "the recorded flow".
 */

export const RiskClass = z.enum([
  /** Read-only. Navigation, reads, extraction. */
  "safe",
  /** Mutates state but trivially undoable / non-financial. */
  "reversible",
  /** Money movement, account creation/closure, permission changes, submits that
   *  cannot be undone from the UI. Gated by policy at replay time. */
  "irreversible",
]);
export type RiskClass = z.infer<typeof RiskClass>;

export const Transform = z.discriminatedUnion("op", [
  z.object({ op: z.literal("trim") }),
  z.object({ op: z.literal("regex_capture"), pattern: z.string(), group: z.number().int().default(1) }),
  z.object({ op: z.literal("strip_currency") }),
  z.object({ op: z.literal("to_number") }),
  z.object({ op: z.literal("to_date"), from: z.string().default("MM/DD/YYYY") }),
]);

export type Transform = z.infer<typeof Transform>;

export const Action = z.discriminatedUnion("do", [
  z.object({ do: z.literal("navigate"), url: ValueExpr }),
  z.object({ do: z.literal("click"), target: Locator }),
  z.object({
    do: z.literal("type"),
    target: Locator,
    value: ValueExpr,
    /** Marks the *action*, so evidence capture knows to mask keystrokes. */
    sensitivity: Sensitivity.default("internal"),
    clearFirst: z.boolean().default(true),
  }),
  z.object({ do: z.literal("select"), target: Locator, value: ValueExpr }),
  z.object({ do: z.literal("press"), keys: z.string() }),
  z.object({ do: z.literal("wait_for"), until: Assertion, timeoutMs: z.number().int().default(15000) }),
  /** Read a value off the surface into a run-scoped binding. */
  z.object({
    do: z.literal("read"),
    target: Locator,
    source: z.enum(["text", "value", "attribute"]).default("text"),
    attribute: z.string().optional(),
    into: Id,
    transforms: z.array(Transform).default([]),
  }),
  z.object({ do: z.literal("assert"), that: Assertion }),
]);
export type Action = z.infer<typeof Action>;

export const Step = z.object({
  id: Id,
  /**
   * The model's stated intent, preserved verbatim from discovery. Not executed.
   * It is what a human reads during review and during an escalation, and what a
   * re-discovery run uses as the goal when a step can no longer be resolved.
   */
  intent: z.string().max(300),
  action: Action,
  risk: RiskClass.default("safe"),
  /** Must hold before we act; guards against acting on the wrong screen. */
  preconditions: z.array(Assertion).default([]),
  /** Must hold after; this is what turns a click into a verified transition. */
  postconditions: z.array(Assertion).default([]),
  /** Steps that may legitimately be absent (e.g. an interstitial that sometimes shows). */
  optional: z.boolean().default(false),
  timeoutMs: z.number().int().default(15000),
  retry: z
    .object({ maxAttempts: z.number().int().min(1).default(1), backoffMs: z.number().int().default(500) })
    .default({}),
  evidence: z
    .object({ screenshot: z.enum(["never", "on_failure", "always"]).default("on_failure") })
    .default({}),
});
export type Step = z.infer<typeof Step>;

/**
 * (b) Something the run can handle and continue. Declared per capability so
 * "dismiss the maintenance banner" is an explicit, reviewed behaviour rather
 * than a global heuristic that might dismiss a real confirmation dialog.
 */
export const RecoverableCondition = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  description: z.string(),
  detect: Assertion,
  handle: z.discriminatedUnion("strategy", [
    /** Click through a known interstitial, then resume the current step. */
    z.object({ strategy: z.literal("run_steps"), steps: z.array(z.lazy((): z.ZodType<Step, z.ZodTypeDef, unknown> => Step)) }),
    z.object({ strategy: z.literal("retry_step"), backoffMs: z.number().int().default(1000) }),
    z.object({ strategy: z.literal("wait"), forMs: z.number().int() }),
    /** Session expiry: re-run the declared entry/login sequence, then resume. */
    z.object({ strategy: z.literal("reenter"), fromStepId: Id.optional() }),
    z.object({ strategy: z.literal("escalate") }),
  ]),
  maxAttempts: z.number().int().min(1).default(2),
  /** Scope: check before every step, or only where the recorder saw it. */
  appliesTo: z.union([z.literal("all_steps"), z.array(Id)]).default("all_steps"),
});

export type RecoverableCondition = z.infer<typeof RecoverableCondition>;
