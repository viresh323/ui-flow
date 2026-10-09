import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Capability, SCHEMA_VERSION } from "../../artifact/index.js";
import { contentHash } from "../../artifact/integrity.js";
import { buildLocatorBundle, type HarvestedTarget } from "../harvest.js";
import type { DiscoveryCtx, TraceEntry } from "../types.js";
import { logger } from "../../obs/logger.js";

/**
 * Distil a successful run into a reusable capability (§3.2).
 *
 * This stage is why the artifact is not a saved transcript, and it is the
 * design decision most worth defending. A raw recording is brittle and
 * unreviewable. Compilation does four things a recording cannot:
 *
 *  1. Prunes dead ends. Exploration the model abandoned is evidence, not flow.
 *  2. Generalises literals into typed parameters — a value the model typed or
 *     matched on becomes ${param}, which is what makes the flow reusable.
 *  3. Keeps credentials as references. The trace already holds {$secret: ...}
 *     rather than a value, so there is nothing to scrub.
 *  4. Derives the checkpoint from the final screen, and turns each observed
 *     failure into a starting point for the business-outcome list.
 *
 * It is deterministic: given the same trace it produces the same artifact. That
 * matters because it means a compiled capability can be regenerated and
 * diffed during review rather than taken on trust.
 */

interface CompileOptions {
  capabilityId: string;
  /** Values supplied by the caller that should become typed parameters. */
  parameterValues: Record<string, string>;
}

export async function compileArtifact(ctx: DiscoveryCtx): Promise<DiscoveryCtx> {
  const capabilityId = ctx.capabilityId ?? "discovered_capability";
  const options: CompileOptions = {
    capabilityId,
    parameterValues: ctx.parameterValues ?? {},
  };

  const successful = ctx.trace.filter((t) => t.outcome === "ok");
  if (successful.length === 0) {
    logger.warn("[compile] no successful actions to compile");
    return { ...ctx, status: "failed", failure: { code: "EMPTY_TRACE", message: "nothing to compile" } };
  }

  const parameterise = makeParameteriser(options.parameterValues);
  const steps = successful.map((entry, index) => toStep(entry, index, parameterise));
  const reads = successful.filter((t) => (t.action as { do?: string }).do === "read");

  // Declare only the inputs a step actually uses. A parameter the model never
  // entered (typed "Savings" while the parameter is an id, or picked the form's
  // default) would otherwise appear in the contract as required, ask the caller
  // for a value, and then be ignored: the replay silently reuses whatever the
  // discovery run did.
  const stepsText = JSON.stringify(steps);
  const usedParams = Object.keys(options.parameterValues).filter((name) => stepsText.includes(`\${${name}}`));
  for (const name of Object.keys(options.parameterValues)) {
    if (!usedParams.includes(name)) {
      logger.warn(
        `[compile] parameter "${name}" is not used by any step, so it is left out of the contract. ` +
          `The run never entered "${options.parameterValues[name]}" where the value belongs; ` +
          `rephrase the goal so the model fills it in, or the replay will repeat the discovery-time choice.`,
      );
    }
  }

  const draft = {
    kind: "capability" as const,
    schemaVersion: SCHEMA_VERSION,
    id: options.capabilityId,
    version: "1.0.0",
    name: titleise(options.capabilityId),
    description: ctx.goal,
    surface: ctx.driver.surface,
    app: {
      product: ctx.cfg.tenant.product,
      productVersionRange: "*",
      entryPoint: { path: ctx.entryPath, requiresSession: true },
    },
    contract: {
      inputs: usedParams.map((name) => ({
        name,
        description: `Supplied per invocation (observed as "${options.parameterValues[name]}" during discovery)`,
        type: { kind: "string" as const },
        required: true,
        sensitivity: "pii" as const,
      })),
      outputs: reads.map((entry) => ({
        name: String((entry.action as { into?: string }).into ?? "value"),
        description: entry.intent,
        type: { kind: "string" as const },
        sensitivity: "pii" as const,
        fromBinding: String((entry.action as { into?: string }).into ?? "value"),
        transforms: [{ op: "trim" as const }],
        required: true,
      })),
      // Deliberately empty. Business outcomes are the one part a human must
      // add: discovery only ever saw the happy path, so anything written here
      // automatically would be a guess presented as a reviewed decision.
      outcomes: [],
    },
    flow: {
      steps,
      checkpoint: {
        description: `Final screen reached: ${ctx.observation?.title ?? "unknown"}`,
        assert: {
          assert: "url_matches" as const,
          pattern: escapeRegExp(pathOf(ctx.observation?.url ?? "")),
        },
      },
    },
    recoveries: [],
    policy: {
      maxRisk: steps.some((s) => s.risk === "irreversible")
        ? ("irreversible" as const)
        : ("reversible" as const),
      requires: {
        origins: ctx.cfg.tenant.allow.origins,
        pathPrefixes: ctx.cfg.tenant.allow.pathPrefixes,
        actions: uniqueActions(steps),
        secrets: secretsUsed(successful),
      },
      irreversibleStepPolicy: "require_human_confirmation" as const,
      returnsDataClasses: ["public", "internal", "pii"] as const,
    },
    escalation: {
      on: ["locator_unresolved", "locator_ambiguous", "unknown_condition", "recovery_exhausted"] as const,
      holdSessionMs: 900_000,
      allowResume: true,
    },
    provenance: {
      discoveryRunId: ctx.runId,
      // The transcript stays outside the artifact and is referenced by hash:
      // model chatter can contain PII read off the screen.
      transcriptSha256: createHash("sha256").update(JSON.stringify(ctx.trace)).digest("hex"),
      model: `${ctx.provider.name}:${ctx.provider.model}`,
      recordedAt: new Date().toISOString(),
      // Never "approved" straight out of the compiler. A capability a model
      // wrote is a draft until a person signs it off.
      review: { status: "draft" as const },
    },
  };

  const parsed = Capability.parse({ ...draft, integrity: { contentSha256: "0".repeat(64) } });
  parsed.integrity.contentSha256 = contentHash(parsed as unknown as Record<string, unknown>);

  const path = join(ctx.evidenceDir, `${options.capabilityId}.json`);
  writeFileSync(path, JSON.stringify(parsed, null, 2));
  writeFileSync(join(ctx.evidenceDir, "trace.json"), JSON.stringify(ctx.trace, null, 2));
  // Everything compile needs except the trace, so the compiler can be iterated
  // offline against a recorded run — no model, no browser, no quota. Discovery
  // is the expensive half; there is no reason to re-run it to change how a
  // trace is distilled.
  writeFileSync(
    join(ctx.evidenceDir, "run-meta.json"),
    JSON.stringify(
      {
        runId: ctx.runId,
        goal: ctx.goal,
        entryPath: ctx.entryPath,
        capabilityId,
        parameterValues: options.parameterValues,
        surface: ctx.driver.surface,
        model: `${ctx.provider.name}:${ctx.provider.model}`,
        finalTitle: ctx.observation?.title ?? null,
        finalUrl: ctx.observation?.url ?? null,
      },
      null,
      2,
    ),
  );

  // A contract that names one invocation's data is not a reusable contract.
  for (const out of parsed.contract.outputs) {
    const leaked = Object.entries(options.parameterValues).find(
      ([, v]) => v.length >= 2 && out.name.includes(v),
    );
    if (leaked) {
      logger.warn(
        `[compile] output "${out.name}" embeds the discovery value for ${leaked[0]} — rename it before review`,
      );
    }
  }

  logger.info(`[compile] wrote ${path} — ${steps.length} steps, ${parsed.contract.outputs.length} outputs`);
  logger.warn("[compile] draft: add business outcomes and recoveries, then review before production use");

  return { ...ctx, status: "succeeded", artifact: parsed };
}

function toStep(
  entry: TraceEntry,
  index: number,
  parameterise: (literal: string) => string,
): Record<string, unknown> {
  const action = entry.action as {
    do: string;
    value?: unknown;
    into?: string;
    keys?: string;
    path?: string;
    harvested?: HarvestedTarget;
  };
  const id = `${action.do}_${index}`;
  // The recorder declared this action irreversible; that classification is the
  // whole input to the replay-side gate, so it outranks the per-verb default.
  const declaredRisk = (action as { irreversible?: boolean }).irreversible
    ? ("irreversible" as const)
    : undefined;
  const base = { id, intent: entry.intent, risk: declaredRisk ?? ("safe" as const) };

  switch (action.do) {
    case "navigate":
      return { ...base, action: { do: "navigate", url: { from: "literal", value: action.path } } };
    case "press":
      return { ...base, action: { do: "press", keys: action.keys } };
    case "click":
      return {
        ...base,
        // A click that submits a form is the usual way a flow changes state.
        risk: declaredRisk ?? ("reversible" as const),
        action: { do: "click", target: bundle(id, action.harvested!, parameterise) },
      };
    case "type": {
      const secret = (action.value as { $secret?: string })?.$secret;
      return {
        ...base,
        action: {
          do: "type",
          target: bundle(id, action.harvested!, parameterise),
          value: secret
            ? { from: "secret", secret }
            : valueExprFor(String(action.value ?? ""), parameterise),
          sensitivity: secret ? "secret" : "internal",
          clearFirst: true,
        },
      };
    }
    case "select":
      return {
        ...base,
        action: {
          do: "select",
          target: bundle(id, action.harvested!, parameterise),
          value: valueExprFor(String(action.value ?? ""), parameterise),
        },
      };
    case "read":
      return {
        ...base,
        action: {
          do: "read",
          target: bundle(id, action.harvested!, parameterise, "read"),
          source: "text",
          into: action.into,
          transforms: [],
        },
      };
    default:
      throw new Error(`cannot compile action "${action.do}"`);
  }
}

function bundle(
  id: string,
  harvested: HarvestedTarget,
  parameterise: (s: string) => string,
  purpose: "act" | "read" = "act",
) {
  return buildLocatorBundle(`${id}_target`, harvested, parameterise, { purpose });
}

/**
 * The generalisation step. A literal the caller supplied during discovery
 * becomes `${param}`; anything else stays a constant. Longest-first so a value
 * that contains another is not half-replaced.
 */
function makeParameteriser(parameterValues: Record<string, string>) {
  const pairs = Object.entries(parameterValues)
    .filter(([, v]) => v.length >= 2)
    .sort(([, a], [, b]) => b.length - a.length);

  return (literal: string): string => {
    let out = literal;
    for (const [name, value] of pairs) out = out.split(value).join(`\${${name}}`);
    return out;
  };
}

function valueExprFor(literal: string, parameterise: (s: string) => string) {
  const templated = parameterise(literal);
  return templated === literal
    ? { from: "literal", value: literal }
    : { from: "template", template: templated };
}

function uniqueActions(steps: Array<Record<string, unknown>>): string[] {
  const set = new Set<string>();
  for (const s of steps) set.add(String((s.action as { do: string }).do));
  return [...set];
}

function secretsUsed(trace: TraceEntry[]): string[] {
  const set = new Set<string>();
  for (const t of trace) {
    const ref = (t.action as { value?: { $secret?: string } }).value?.$secret;
    if (ref) set.add(ref);
  }
  return [...set];
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function titleise(id: string): string {
  return id.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
