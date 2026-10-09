/**
 * The control-transfer model (§3.6).
 *
 * Two things must be true at once for a handoff to be real: the *session* has
 * to survive (same tab, same cookies, same half-filled form), and *ownership*
 * has to be unambiguous at every instant. A system where both the automation
 * and a person can act is worse than one where neither can.
 *
 * Ownership is therefore explicit and single-valued. The driver enforces it:
 * automation entry points throw while a human holds control, and the operator
 * entry points are the only ones that work. There is no polite convention to
 * forget.
 */

export type Controller = "automation" | "human";

export type InterventionState =
  | "pending" // raised, nobody has picked it up
  | "claimed" // an operator holds control of the live session
  | "returned" // operator handed back; automation may resume
  | "aborted"; // operator gave up; the run should fail cleanly

/** What the human actually did while holding control. */
export interface HumanAction {
  at: string;
  operator: string;
  kind: "click" | "type" | "press" | "navigate" | "note";
  /** Viewport coordinates, for a click. */
  at_xy?: { x: number; y: number };
  /**
   * Redacted before storage when the field was a password. We record that a
   * value was entered and where, never the value itself.
   */
  value?: string;
  urlAfter: string;
}

export interface InterventionRequest {
  interventionId: string;
  raisedAt: string;
  /** Enough context to act without reading the logs. */
  capabilityId: string;
  capabilityVersion: string;
  tenantId: string;
  runId: string;
  goal: string;
  atStepId: string;
  reason: string;
  expected: string;
  observed: string;
  /** The live session the operator takes over. */
  sessionId: string;
  connectUrl: string;
}

export interface Intervention extends InterventionRequest {
  state: InterventionState;
  controller: Controller;
  operator?: string;
  claimedAt?: string;
  resolvedAt?: string;
  humanActions: HumanAction[];
}

/** What the waiting run receives once the operator is done. */
export interface InterventionResolution {
  decision: "resume" | "abort";
  humanActions: HumanAction[];
  operator?: string;
}
