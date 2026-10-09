import type { Capability } from "../artifact/index.js";
import type { AppConfig } from "../config/config.js";
import type { AiProvider, ProviderUsage } from "../providers/aiProvider.js";
import type { Observation, SurfaceDriver } from "../surface/driver.js";

/**
 * One entry in the discovery trace.
 *
 * The trace is the raw record of what the model did. It is deliberately NOT the
 * artifact: it contains dead ends, retries, literal values observed on screen,
 * and the model's own reasoning. The compile stage distils it into a capability;
 * the trace itself is evidence, retained under the evidence retention policy and
 * referenced from the artifact by hash only.
 */
export interface TraceEntry {
  stepIndex: number;
  /** The model's stated reason for this action, kept verbatim. */
  intent: string;
  action: Record<string, unknown>;
  /** How the element was found, if this action targeted one. */
  targeting?: { strategy: string; candidateIndex: number; matchCount: number };
  observationBefore: { url: string; title: string };
  outcome: "ok" | "failed";
  /** Identity of the action as proposed, used by the repeat guard. */
  proposedKey?: string;
  error?: string;
  at: string;
}

export type DiscoveryStatus = "running" | "succeeded" | "escalated" | "failed";

/**
 * Pipeline state.
 *
 * Single `ctx` channel with a merging reducer, exactly as the reference
 * orchestrator does it, so stage functions stay plain `(ctx) => ctx` with no
 * graph coupling and can be unit-tested without LangGraph in the picture.
 *
 * Non-serializable members (driver, provider, cfg) are threaded through but
 * excluded from what gets checkpointed — see `serializableCtx`.
 */
export interface DiscoveryCtx {
  runId: string;
  goal: string;
  entryPath: string;
  tenantId: string;

  cfg: AppConfig;
  provider: AiProvider;
  driver: SurfaceDriver;

  stepIndex: number;
  status: DiscoveryStatus;
  trace: TraceEntry[];
  observation?: Observation;

  /** Set by `decide`, consumed by `act` or by the router. */
  decision?: {
    kind: "act" | "done" | "stuck";
    intent: string;
    action?: Record<string, unknown>;
    reason?: string;
  };

  usage: ProviderUsage;
  usageByStage: Record<string, ProviderUsage>;

  /**
   * Whether this recording session may perform actions that cannot be undone.
   * Off by default. Recording a write flow means actually performing it, so it
   * is opt-in per run, meant for a test environment and an authorised person —
   * the guardrail that protects production lives on the replay side.
   */
  allowIrreversible?: boolean;

  /** Id for the capability this run is recording. */
  capabilityId?: string;
  /** Caller-supplied values that should become typed parameters when compiled. */
  parameterValues?: Record<string, string>;

  artifact?: Capability;
  escalation?: { reason: string; atStep: number; sessionId: string; connectUrl: string };
  failure?: { code: string; message: string };

  evidenceDir: string;
}

/** What is safe to persist into the checkpoint database. */
export function serializableCtx(ctx: DiscoveryCtx): Record<string, unknown> {
  const { cfg: _cfg, provider: _p, driver: _d, observation, ...rest } = ctx;
  return {
    ...rest,
    // Screenshots are evidence files, not checkpoint rows.
    observation: observation
      ? { url: observation.url, title: observation.title, tree: observation.tree }
      : undefined,
  };
}
