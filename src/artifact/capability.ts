import { z } from "zod";
import { Assertion, BusinessOutcome } from "./conditions.js";
import { Locator } from "./locator.js";
import { RecoverableCondition, RiskClass, Step, Transform } from "./steps.js";
import { FieldType, Id, Semver, Sensitivity, ValueExpr } from "./values.js";

export const SCHEMA_VERSION = "1.0.0";

/* ---------------------------------------------------------------- contract */

export const InputParam = z.object({
  name: Id,
  description: z.string(),
  type: FieldType,
  required: z.boolean().default(true),
  default: ValueExpr.optional(),
  sensitivity: Sensitivity.default("internal"),
});

export const OutputField = z.object({
  name: Id,
  description: z.string(),
  type: FieldType,
  sensitivity: Sensitivity.default("internal"),
  /** Bound from a `read` step's `into`, or assembled from several. */
  fromBinding: Id,
  transforms: z.array(Transform).default([]),
  required: z.boolean().default(true),
});

/* ------------------------------------------------------------------ policy */

export const Policy = z.object({
  /** Highest risk of any step; denormalized so a caller can gate without walking the flow. */
  maxRisk: RiskClass,
  /** Allowlist the *capability* asserts it needs. Runtime intersects this with the
   *  tenant's grant; a capability may never widen its own permissions. */
  requires: z.object({
    origins: z.array(z.string()).min(1).describe("scheme://host[:port] the flow may touch"),
    pathPrefixes: z.array(z.string()).default(["/"]),
    actions: z.array(z.enum(["navigate", "click", "type", "select", "press", "read"])),
    secrets: z.array(z.string()).default([]).describe("secret refs this capability may resolve"),
  }),
  /** What to do when an irreversible step is reached. */
  irreversibleStepPolicy: z
    .enum(["block", "require_human_confirmation", "allow_with_audit"])
    .default("require_human_confirmation"),
  /** Data classes the capability is permitted to return. Enforced at the boundary. */
  returnsDataClasses: z.array(Sensitivity).default(["public", "internal"]),
});

export const EscalationPolicy = z.object({
  /** Conditions that should page a human rather than fail the run. */
  on: z
    .array(
      z.enum([
        "locator_unresolved",
        "locator_ambiguous",
        "unknown_condition",
        "irreversible_step",
        "recovery_exhausted",
        "timeout",
      ]),
    )
    .default(["locator_unresolved", "locator_ambiguous", "unknown_condition", "recovery_exhausted"]),
  /** How long the session is held open awaiting a human before it is abandoned. */
  holdSessionMs: z.number().int().default(15 * 60 * 1000),
  /** Whether the human may resume the flow, or only observe and abort. */
  allowResume: z.boolean().default(true),
});

/* -------------------------------------------------------------- provenance */

export const Provenance = z.object({
  /** The discovery run this was compiled from. The raw transcript lives outside
   *  the artifact and is referenced by hash — artifacts must not embed model
   *  chatter, which may contain PII observed on screen. */
  discoveryRunId: z.string(),
  transcriptSha256: z.string().length(64),
  model: z.string(),
  recordedAt: z.string().datetime(),
  /** A capability is not invocable in production until a human has approved it. */
  review: z.object({
    status: z.enum(["draft", "approved", "deprecated"]).default("draft"),
    reviewer: z.string().optional(),
    reviewedAt: z.string().datetime().optional(),
    notes: z.string().optional(),
  }),
});

/* -------------------------------------------------------------- capability */

export const Capability = z.object({
  kind: z.literal("capability"),
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: Id.describe("stable across versions, e.g. read_account_balance"),
  version: Semver,
  name: z.string(),
  /** Agent-facing summary. This is what a planner model reads when choosing a tool. */
  description: z.string(),

  surface: z.enum(["web", "desktop_uia", "terminal"]),

  /** Binds the capability to a *vendor product*, not a tenant. Reuse lives here. */
  app: z.object({
    product: z.string().describe("e.g. parabank"),
    productVersionRange: z.string().default("*"),
    entryPoint: z.object({
      /** Relative to the tenant's configured base URL — never a hardcoded host. */
      path: z.string(),
      requiresSession: z.boolean().default(true),
    }),
  }),

  contract: z.object({
    inputs: z.array(InputParam),
    outputs: z.array(OutputField),
    /** Declared business results. Success is implicit; these are the others. */
    outcomes: z.array(BusinessOutcome).default([]),
  }),

  flow: z.object({
    steps: z.array(Step).min(1),
    /** The success condition. Replay returns success only if this holds. */
    checkpoint: z.object({
      description: z.string(),
      assert: Assertion,
    }),
  }),

  recoveries: z.array(RecoverableCondition).default([]),
  policy: Policy,
  escalation: EscalationPolicy.default({}),
  provenance: Provenance,

  /** sha256 over the canonicalized artifact minus this field. Replay refuses to
   *  execute an artifact whose hash does not match — tamper-evidence for a
   *  thing that moves money. */
  integrity: z.object({ contentSha256: z.string().length(64) }),
});
export type Capability = z.infer<typeof Capability>;

/* ----------------------------------------------------------------- overlay */

/**
 * Multi-tenant specialization.
 *
 * The base capability is recorded once per vendor product. A tenant whose
 * instance differs (renamed label, extra approval dialog, older version) gets a
 * thin overlay rather than a re-recorded flow. Overlays are *narrow by
 * construction*: they may retarget a locator, adjust a timeout, add a recovery,
 * or insert/skip a step — they may not rewrite the contract, because callers
 * depend on it being identical across tenants.
 */
export const TenantOverlay = z.object({
  kind: z.literal("overlay"),
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: Id,
  version: Semver,
  tenantId: z.string(),
  base: z.object({ capabilityId: Id, versionRange: z.string() }),
  patches: z
    .array(
      z.discriminatedUnion("patch", [
        z.object({ patch: z.literal("retarget"), locatorId: Id, with: Locator }),
        z.object({ patch: z.literal("timeout"), stepId: Id, timeoutMs: z.number().int() }),
        z.object({ patch: z.literal("insert_step"), afterStepId: Id.optional(), step: Step }),
        z.object({ patch: z.literal("skip_step"), stepId: Id, reason: z.string() }),
        z.object({ patch: z.literal("add_recovery"), recovery: RecoverableCondition }),
        z.object({ patch: z.literal("add_outcome"), outcome: BusinessOutcome }),
      ]),
    )
    .min(1),
  provenance: Provenance,
  integrity: z.object({ contentSha256: z.string().length(64) }),
});
export type TenantOverlay = z.infer<typeof TenantOverlay>;

export const Artifact = z.discriminatedUnion("kind", [Capability, TenantOverlay]);
export type Artifact = z.infer<typeof Artifact>;
