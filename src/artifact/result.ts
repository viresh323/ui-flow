import { z } from "zod";
import { Id, JsonValue, Sensitivity } from "./values.js";

/**
 * The replay result contract — what the calling agent actually receives.
 *
 * Four terminal states, matching the taxonomy the brief asks for plus the
 * human-in-the-loop case. The caller must be able to branch on `status` alone.
 */

export const LocatorResolution = z.object({
  locatorId: Id,
  stepId: Id,
  /** Index into the candidate bundle that won. Rising indices across runs are
   *  the early-warning signal for per-tenant/version drift: the artifact still
   *  works, but it is now leaning on weaker strategies. Emitted every run and
   *  aggregated per tenant so drift is detected before it becomes an outage. */
  resolvedByCandidate: z.number().int(),
  strategy: z.string(),
  confidence: z.number(),
  matchCount: z.number().int(),
  elapsedMs: z.number().int(),
});

export const EvidenceRef = z.object({
  kind: z.enum(["screenshot", "ax_snapshot", "dom_snapshot", "trace", "har"]),
  /** Pointer into evidence storage; never inline. Retention is policy-driven. */
  uri: z.string(),
  redacted: z.boolean(),
  capturedAtStepId: Id.optional(),
});

const Base = z.object({
  runId: z.string(),
  capabilityId: Id,
  capabilityVersion: z.string(),
  tenantId: z.string(),
  startedAt: z.string().datetime(),
  durationMs: z.number().int(),
  stepsAttempted: z.number().int(),
  resolutions: z.array(LocatorResolution).default([]),
  evidence: z.array(EvidenceRef).default([]),
  /**
   * What a human did during the run, if one was called in. Part of the result
   * contract rather than buried in a log: a caller that gets a success needs to
   * know whether a person had to touch it, and an auditor needs it without
   * digging. Values are redacted; the fact and the place are not.
   */
  humanActions: z
    .array(
      z.object({
        at: z.string(),
        operator: z.string(),
        kind: z.string(),
        value: z.string().optional(),
        urlAfter: z.string(),
      }),
    )
    .default([]),
});

export const ReplayResult = z.discriminatedUnion("status", [
  /** Checkpoint held. Outputs conform to the declared contract. */
  Base.extend({
    status: z.literal("success"),
    outputs: z.record(JsonValue),
    outputSensitivity: z.record(Sensitivity).default({}),
  }),
  /**
   * A declared business result. NOT an error — the caller is expected to handle
   * it. e.g. MEMBER_NOT_FOUND, INSUFFICIENT_FUNDS, PERMISSION_DENIED.
   */
  Base.extend({
    status: z.literal("business_outcome"),
    outcome: z.string(),
    message: z.string(),
    outputs: z.record(JsonValue).default({}),
  }),
  /** Paused and handed to a human. The session is held open; see handoff. */
  Base.extend({
    status: z.literal("escalated"),
    reason: z.enum([
      "locator_unresolved",
      "locator_ambiguous",
      "unknown_condition",
      "irreversible_step",
      "recovery_exhausted",
      "timeout",
    ]),
    interventionId: z.string(),
    atStepId: Id,
    sessionId: z.string(),
  }),
  /** Hard failure. Must carry enough to debug without re-running. */
  Base.extend({
    status: z.literal("failed"),
    error: z.object({
      code: z.string(),
      atStepId: Id.optional(),
      /** The three fields a debugger actually wants. */
      expected: z.string(),
      observed: z.string(),
      locatorTried: z.array(z.object({ strategy: z.string(), matchCount: z.number().int() })).default([]),
      recoveriesAttempted: z.array(z.string()).default([]),
    }),
  }),
]);
export type ReplayResult = z.infer<typeof ReplayResult>;
