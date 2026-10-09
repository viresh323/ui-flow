import { z } from "zod";
import { Locator } from "./locator.js";
import { Id, ValueExpr } from "./values.js";

/**
 * Assertions, and the three-way runtime taxonomy.
 *
 * The brief's hardest requirement is that replay distinguish
 *   (a) expected business outcomes,  (b) recoverable conditions,
 *   (c) hard failures.
 * We put that distinction in the *schema*, not in replay code: a condition is
 * business or recoverable because the artifact declares it so, and anything the
 * artifact does not declare is by definition a hard failure. That keeps the
 * replay engine dumb and makes the taxonomy reviewable per capability.
 */

export const Assertion = z.discriminatedUnion("assert", [
  z.object({ assert: z.literal("element_present"), locator: Locator }),
  z.object({ assert: z.literal("element_absent"), locator: Locator }),
  z.object({
    assert: z.literal("text_matches"),
    locator: Locator.optional().describe("omit to match anywhere on the surface"),
    pattern: z.string().describe("RegExp source"),
    flags: z.string().default("i"),
  }),
  z.object({ assert: z.literal("url_matches"), pattern: z.string() }),
  z.object({
    assert: z.literal("value_equals"),
    locator: Locator,
    expected: ValueExpr,
  }),
  z.object({ assert: z.literal("all"), of: z.array(z.lazy(() => Assertion)) }),
  z.object({ assert: z.literal("any"), of: z.array(z.lazy(() => Assertion)) }),
  z.object({ assert: z.literal("not"), of: z.lazy(() => Assertion) }),
]) as z.ZodType<Assertion>;

export type Assertion =
  | { assert: "element_present"; locator: z.infer<typeof Locator> }
  | { assert: "element_absent"; locator: z.infer<typeof Locator> }
  | { assert: "text_matches"; locator?: z.infer<typeof Locator>; pattern: string; flags: string }
  | { assert: "url_matches"; pattern: string }
  | { assert: "value_equals"; locator: z.infer<typeof Locator>; expected: z.infer<typeof ValueExpr> }
  | { assert: "all"; of: Assertion[] }
  | { assert: "any"; of: Assertion[] }
  | { assert: "not"; of: Assertion };

/**
 * (a) A legitimate business answer. NOT an error. The caller gets a structured
 * result and decides what it means. "No such member" belongs here.
 */
export const BusinessOutcome = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "SCREAMING_SNAKE_CASE"),
  description: z.string(),
  detect: Assertion,
  /** Outcome-specific fields, e.g. the validation message shown to the operator. */
  outputs: z.array(Id).default([]),
  /** Whether hitting this stops the flow (usually yes). */
  terminal: z.boolean().default(true),
  /**
   * When to look for it. Scoping is essential, not decoration: "no balance cell
   * for this account" is true on the login screen too, so an unscoped detector
   * would fire ACCOUNT_NOT_FOUND at step one. Naming steps checks the detector
   * immediately after those steps; "checkpoint" (the default) checks it only
   * once the flow has run and its success condition did not hold.
   */
  appliesTo: z.union([z.literal("checkpoint"), z.array(Id)]).default("checkpoint"),
});

export type BusinessOutcome = z.infer<typeof BusinessOutcome>;
