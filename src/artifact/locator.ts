import { z } from "zod";
import { Id } from "./values.js";

/**
 * Element targeting.
 *
 * The single most important decision in this schema: a step does not carry
 * "a selector". It carries a *ranked bundle of candidate strategies* plus a
 * resolution policy. Replay walks the bundle in order and takes the first
 * candidate that resolves uniquely above the confidence floor.
 *
 * Why: on the surfaces we care about (JSP/server-rendered back-office apps)
 * there is no single strategy that is both stable and universally available.
 * Accessible-name targeting is the most portable but many legacy controls have
 * no accessible name; a CSS path is always available but encodes incidental
 * structure. A bundle degrades instead of breaking, and it is also the seam
 * that lets one artifact serve several tenants running the same vendor product
 * with different branding: the branding-sensitive candidates fail, the
 * structural ones still hit.
 *
 * Ordering is by *expected durability*, not by what the recorder found first.
 */

/** Scopes a search. Frames are a path because legacy apps nest framesets. */
export const Region = z.object({
  framePath: z.array(z.string()).default([]).describe("frame name/url fragments, outermost first"),
  within: z
    .object({ landmark: z.string() })
    .optional()
    .describe("optional container, e.g. a section heading or table caption to search inside"),
});
export type Region = z.infer<typeof Region>;

export const LocatorCandidate = z.discriminatedUnion("using", [
  /** Preferred. Portable across web (ARIA) and desktop (UIA control type + Name). */
  z.object({
    using: z.literal("role_name"),
    role: z.string(),
    name: z.string(),
    exact: z.boolean().default(false),
  }),
  /**
   * The workhorse for legacy forms: find the *text* that visually labels a
   * control and take the nearest control of the expected role. Handles
   * `<p><b>Username</b></p><input name=...>` where no <label for> exists.
   */
  z.object({
    using: z.literal("label_proximity"),
    labelText: z.string(),
    controlRole: z.string(),
    direction: z.enum(["after", "before", "below", "right"]).default("after"),
    maxDistance: z.number().int().default(3).describe("DOM/AX hops to search"),
  }),
  /** Server-rendered forms are addressed by name= far more reliably than by id. */
  z.object({ using: z.literal("field_name"), name: z.string(), formName: z.string().optional() }),
  /** Row/column intersection in a data table — the classic back-office grid read. */
  z.object({
    using: z.literal("table_cell"),
    rowMatch: z.object({ columnHeader: z.string(), equals: z.string() }),
    columnHeader: z.string(),
    tableIndex: z.number().int().optional(),
  }),
  /** Anchor-relative: "the Edit link in the row containing 12345". */
  z.object({
    using: z.literal("near_anchor"),
    anchorText: z.string(),
    targetRole: z.string(),
    targetName: z.string().optional(),
  }),
  z.object({ using: z.literal("text"), text: z.string(), exact: z.boolean().default(false) }),
  /** Structural fallback. Brittle to redesign, fine for a stable vendor product. */
  z.object({ using: z.literal("css"), selector: z.string() }),
  z.object({ using: z.literal("xpath"), xpath: z.string() }),
  /** Last resort before escalation, and the bridge to non-DOM surfaces. */
  z.object({
    using: z.literal("ordinal"),
    role: z.string(),
    index: z.number().int().nonnegative(),
  }),
]);
export type LocatorCandidate = z.infer<typeof LocatorCandidate>;

export const RankedCandidate = z.object({
  candidate: LocatorCandidate,
  /** Recorder's durability estimate, 0..1. Also the replay confidence floor input. */
  confidence: z.number().min(0).max(1),
  /** Human-reviewable justification. This is why a reviewer can approve the artifact. */
  rationale: z.string().max(400).optional(),
});

export const Locator = z.object({
  /** Stable handle so tenant overlays can override one target without a diff. */
  id: Id,
  /** One line a human reads in a review or an escalation ticket. */
  describe: z.string().max(200),
  region: Region.default({ framePath: [] }),
  candidates: z.array(RankedCandidate).min(1),
  match: z
    .object({
      requireUnique: z.boolean().default(true),
      minConfidence: z.number().min(0).max(1).default(0.4),
      onMultiple: z.enum(["fail", "first", "escalate"]).default("fail"),
      /** Ambiguity is a *safety* property: silently clicking the wrong row in a
       *  banking grid is worse than failing, so the default is to fail. */
    })
    .default({}),
});
export type Locator = z.infer<typeof Locator>;
