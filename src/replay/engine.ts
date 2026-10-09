import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BusinessOutcome,
  Capability,
  RecoverableCondition,
  ReplayResult,
  Step,
} from "../artifact/index.js";
import { verifyIntegrity } from "../artifact/integrity.js";
import type { AppConfig } from "../config/config.js";
import { authorizeStep, authorizeUrl } from "../config/policy.js";
import { createEnvSecretStore, restrictTo } from "../config/secrets.js";
import type { Resolution, SurfaceDriver } from "../surface/driver.js";
import { initFileLog, logger } from "../obs/logger.js";
import type { InterventionRequest, InterventionResolution } from "../escalation/types.js";
import { describe, evaluate } from "./assertions.js";
import { applyTransforms, coerceOutput, interpolate, resolveValue, type ValueScope } from "./values.js";

/**
 * Deterministic replay (§3.3) — the production execution path.
 *
 * No model. No provider. This module imports nothing from providers/, and that
 * is the one hard guarantee the brief asks for: replay cannot re-reason about
 * the UI even by accident.
 *
 * The engine is deliberately dumb. It does not decide what counts as an error —
 * the artifact declares its business outcomes and its recoverable conditions,
 * a human reviewed them, and anything undeclared is a hard failure by
 * construction. That is what keeps the three-way taxonomy honest.
 */

export interface ReplayInput {
  capability: Capability;
  params: Record<string, unknown>;
  cfg: AppConfig;
  driver: SurfaceDriver;
  /** Set when a human has already approved an irreversible step for this run. */
  humanConfirmed?: boolean;
  evidenceDir?: string;
  /**
   * When supplied, an escalation *suspends* the run instead of ending it: the
   * handler raises an intervention, a human drives the same live session, and
   * the run resumes from the step that stopped. Without it, escalation is
   * terminal and the caller deals with it.
   */
  onEscalation?: (req: InterventionRequest, driver: SurfaceDriver) => Promise<InterventionResolution>;
}

/** Thrown internally to unwind to the result builder; never escapes replay(). */
class HardFailure extends Error {
  constructor(
    readonly code: string,
    readonly expected: string,
    readonly observed: string,
    readonly atStepId?: string,
  ) {
    super(`${code}: expected ${expected}, observed ${observed}`);
  }
}

class BusinessStop extends Error {
  constructor(readonly outcome: BusinessOutcome) {
    super(outcome.code);
  }
}

class Escalation extends Error {
  constructor(readonly reason: ReplayResult extends { reason: infer R } ? R : never, readonly atStepId: string) {
    super(String(reason));
  }
}

export async function replay(input: ReplayInput): Promise<ReplayResult> {
  const { capability: cap, params, cfg, driver } = input;
  const runId = `rp_${Date.now().toString(36)}_${randomUUID().slice(0, 4)}`;
  const evidenceDir = input.evidenceDir ?? join(cfg.runsDir, runId);
  mkdirSync(evidenceDir, { recursive: true });
  // §3.5: every run leaves a structured trail, redacted on the way out.
  initFileLog(join(evidenceDir, "replay.jsonl"));

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const resolutions: ReplayResult["resolutions"] = [];
  const evidence: ReplayResult["evidence"] = [];
  const recoveriesAttempted: string[] = [];
  /**
   * Mutable for the life of this run: an operator authorising an irreversible
   * step through the console grants the confirmation the policy requires.
   */
  const preConfirmed = input.humanConfirmed ?? false;
  // Approval is per step. A single run-wide flag would let one operator's "yes"
  // to the first irreversible step wave through every one after it.
  const approvedSteps = new Set<string>();
  const humanActions: ReplayResult["humanActions"] = [];
  let stepsAttempted = 0;

  const scope: ValueScope = {
    params,
    bindings: new Map<string, string>(),
    secrets: restrictTo(createEnvSecretStore(), cap.policy.requires.secrets),
  };
  const actx = { driver, scope };

  const base = () => ({
    runId,
    capabilityId: cap.id,
    capabilityVersion: cap.version,
    tenantId: cfg.tenant.tenantId,
    startedAt,
    durationMs: Date.now() - t0,
    stepsAttempted,
    resolutions,
    evidence,
    humanActions,
  });

  const captureFailureEvidence = async (label: string) => {
    try {
      const shot = await driver.screenshot();
      const file = join(evidenceDir, `${label}.png`);
      writeFileSync(file, Buffer.from(shot, "base64"));
      evidence.push({ kind: "screenshot", uri: file, redacted: false });

      const obs = await driver.observe();
      const treeFile = join(evidenceDir, `${label}.tree.txt`);
      writeFileSync(treeFile, obs.tree);
      evidence.push({ kind: "ax_snapshot", uri: treeFile, redacted: false });
    } catch (error) {
      logger.warn(`[replay] could not capture evidence: ${(error as Error).message}`);
    }
  };

  try {
    // ---- gate: integrity ------------------------------------------------
    const integrity = verifyIntegrity(cap as unknown as Record<string, unknown>);
    if (!integrity.ok) {
      throw new HardFailure(
        "INTEGRITY_MISMATCH",
        `content hash ${integrity.expected.slice(0, 12)}…`,
        `computed ${integrity.actual.slice(0, 12)}…`,
      );
    }

    // ---- gate: required inputs -------------------------------------------
    for (const input_ of cap.contract.inputs) {
      if (input_.required && params[input_.name] === undefined) {
        throw new HardFailure(
          "MISSING_INPUT",
          `parameter "${input_.name}" (${input_.type.kind})`,
          "not supplied by caller",
        );
      }
    }

    logger.info(`[replay] ${cap.id}@${cap.version} | ${cap.flow.steps.length} steps | run ${runId}`);

    // Start from the declared entry point rather than wherever the session
    // happens to be. The entry point is part of the capability's contract, and
    // a compiled flow usually has no navigate step of its own: discovery began
    // there because the harness put it there, so the first recorded action is
    // already on the right screen. Replay has to reproduce that starting state.
    const entry = cap.app.entryPoint.path;
    const entryGate = authorizeUrl(entry, cfg.tenant);
    if (!entryGate.allowed) {
      throw new HardFailure(entryGate.code, "an entry point inside the tenant allowlist", entryGate.reason);
    }
    await driver.navigate(entry);

    // ---- execute steps ----------------------------------------------------
    for (const step of cap.flow.steps) {
      stepsAttempted += 1;
      await runStep(step);

      const hit = await detectOutcome(cap.contract.outcomes, step.id);
      if (hit) throw new BusinessStop(hit);
    }

    // ---- checkpoint --------------------------------------------------------
    const held = await evaluate(cap.flow.checkpoint.assert, actx);
    if (!held) {
      // The flow ran but the success condition did not hold. Before calling
      // that a failure, ask whether the artifact declared a business outcome
      // for exactly this situation — "no such account" lands here.
      const outcome = await detectOutcome(cap.contract.outcomes, "checkpoint");
      if (outcome) throw new BusinessStop(outcome);

      await captureFailureEvidence("checkpoint-failed");
      throw new HardFailure(
        "CHECKPOINT_FAILED",
        cap.flow.checkpoint.description,
        `not satisfied: ${describe(cap.flow.checkpoint.assert)}`,
      );
    }

    // ---- outputs -----------------------------------------------------------
    const outputs: Record<string, unknown> = {};
    const outputSensitivity: Record<string, string> = {};
    for (const field of cap.contract.outputs) {
      const raw = scope.bindings.get(field.fromBinding);
      if (raw === undefined) {
        if (!field.required) continue;
        throw new HardFailure(
          "MISSING_OUTPUT",
          `output "${field.name}" from binding "${field.fromBinding}"`,
          "binding was never captured",
        );
      }
      // The backstop for the race above, and for any future read that loses it:
      // a required output that came back blank is a failed read, not a success
      // carrying an empty string. Returning "" would hand the caller something
      // indistinguishable from a legitimately empty field.
      if (field.required && raw.trim() === "") {
        throw new HardFailure(
          "EMPTY_OUTPUT",
          `a value for required output "${field.name}"`,
          "the element resolved but its content was empty",
        );
      }
      if (!cap.policy.returnsDataClasses.includes(field.sensitivity)) {
        throw new HardFailure(
          "OUTPUT_NOT_PERMITTED",
          `data class ${field.sensitivity} in returnsDataClasses`,
          `capability policy permits only ${cap.policy.returnsDataClasses.join(", ")}`,
        );
      }
      outputs[field.name] = coerceOutput(applyTransforms(raw, field.transforms), field.type.kind);
      outputSensitivity[field.name] = field.sensitivity;
    }

    logger.info(`[replay] success in ${Date.now() - t0}ms`);
    return { ...base(), status: "success", outputs, outputSensitivity } as ReplayResult;
  } catch (error) {
    if (error instanceof BusinessStop) {
      logger.info(`[replay] business outcome: ${error.outcome.code}`);
      return {
        ...base(),
        status: "business_outcome",
        outcome: error.outcome.code,
        message: error.outcome.description,
        outputs: {},
      } as ReplayResult;
    }

    if (error instanceof Escalation) {
      // Evidence first: ceding control locks out automation, screenshots
      // included, and an intervention request without a screenshot is far less
      // useful to the operator who has to act on it.
      await captureFailureEvidence("escalation");
      const session = await driver.cedeControl();
      logger.warn(`[replay] escalating: ${error.reason} at ${error.atStepId}`);
      return {
        ...base(),
        status: "escalated",
        reason: error.reason,
        interventionId: `iv_${runId}`,
        atStepId: error.atStepId,
        sessionId: session.sessionId,
      } as ReplayResult;
    }

    const failure =
      error instanceof HardFailure
        ? error
        : new HardFailure("UNEXPECTED_ERROR", "the step to complete", (error as Error).message);

    logger.error(`[replay] failed: ${failure.code} at ${failure.atStepId ?? "-"}`);
    return {
      ...base(),
      status: "failed",
      error: {
        code: failure.code,
        atStepId: failure.atStepId,
        expected: failure.expected,
        observed: failure.observed,
        locatorTried: [],
        recoveriesAttempted,
      },
    } as ReplayResult;
  }

  // ---- helpers ------------------------------------------------------------

  async function detectOutcome(
    outcomes: BusinessOutcome[],
    at: string,
  ): Promise<BusinessOutcome | null> {
    for (const outcome of outcomes) {
      const inScope =
        outcome.appliesTo === "checkpoint" ? at === "checkpoint" : outcome.appliesTo.includes(at);
      if (!inScope) continue;
      if (await evaluate(outcome.detect, actx)) return outcome;
    }
    return null;
  }

  async function detectRecovery(stepId: string): Promise<RecoverableCondition | null> {
    for (const rec of cap.recoveries) {
      const inScope = rec.appliesTo === "all_steps" || rec.appliesTo.includes(stepId);
      if (!inScope) continue;
      if (await evaluate(rec.detect, actx)) return rec;
    }
    return null;
  }

  async function runStep(step: Step): Promise<void> {
    const attemptsAllowed = Math.max(step.retry.maxAttempts, maxRecoveryAttempts(step.id));
    let intervened = false;
    // Set once an irreversible step's action has gone through. After that the
    // step must never run again: a failed postcondition does not mean it did not
    // happen, and a second attempt could be a second transfer.
    let irreversibleDone = false;

    // +1 attempt so a human unblocking the step still gets a run at it.
    for (let attempt = 1; attempt <= attemptsAllowed + 1; attempt += 1) {
      try {
        // Inside the try, deliberately. When this gate was checked outside it,
        // the escalation it raises bypassed the catch below — so an
        // irreversible step could never be handed to a human, which is the one
        // case the operator console exists for. The locator-unresolved path is
        // thrown from performAction and was inside the try, which is why the
        // handoff test passed while this was broken.
        const gate = authorizeStep(step.risk, cap, {
          humanConfirmed: preConfirmed || approvedSteps.has(step.id),
        });
        if (!gate.allowed) {
          if (gate.code === "NEEDS_HUMAN_CONFIRMATION") {
            throw new Escalation("irreversible_step" as never, step.id);
          }
          throw new HardFailure(gate.code, "an action permitted by policy", gate.reason, step.id);
        }

        for (const pre of step.preconditions) {
          if (!(await evaluate(pre, actx))) {
            if (step.optional) {
              logger.debug(`[replay] ${step.id}: optional step skipped (precondition not met)`);
              return;
            }
            throw new HardFailure("PRECONDITION_FAILED", describe(pre), "did not hold", step.id);
          }
        }

        await performAction(step);
        if (step.risk === "irreversible") irreversibleDone = true;

        for (const post of step.postconditions) {
          if (!(await evaluate(post, actx))) {
            throw new HardFailure("POSTCONDITION_FAILED", describe(post), "did not hold", step.id);
          }
        }

        logger.info(`[replay] ${step.id}: ok`);
        return;
      } catch (error) {
        if (error instanceof BusinessStop) throw error;

        // Order matters here, and this is the heart of the three-way taxonomy.
        //
        // A declared business outcome *explains* the failure, and outranks
        // everything else: the balance cell failing to resolve because the
        // account does not exist is an answer the caller asked for, not a stuck
        // run. Reporting it as an escalation would summon a human to answer a
        // question the artifact already knows how to answer.
        const explained = await detectOutcome(cap.contract.outcomes, step.id);
        if (explained) throw new BusinessStop(explained);

        // Whatever went wrong, an irreversible step that has already acted is not
        // retried, recovered or handed back to be done again.
        if (irreversibleDone) throw error;

        // Then a declared recoverable condition, which retries in place.
        const rec = await detectRecovery(step.id);
        if (rec && attempt < attemptsAllowed) {
          recoveriesAttempted.push(rec.code);
          logger.warn(`[replay] ${step.id}: ${rec.code} — ${rec.handle.strategy} (attempt ${attempt})`);
          try {
            await handleRecovery(rec);
            continue;
          } catch (recoveryError) {
            // The recovery itself failed (its own steps could not find their
            // element). Thrown from here it would leave this catch block and
            // skip everything below, so a person could never be called in for
            // the one situation where automation has nothing left to try. Treat
            // it as the failure we now have, and carry on to the checks below.
            logger.warn(`[replay] ${step.id}: recovery ${rec.code} failed: ${(recoveryError as Error).message}`);
            error = recoveryError;
          }
        }

        // An escalation with a human on call suspends the run rather than
        // ending it: cede the live session, wait for a person, then retry the
        // step they just unblocked. One intervention per step — if it stops
        // again at the same place, the human's fix did not work and looping
        // them is worse than failing.
        if (error instanceof Escalation && input.onEscalation && !intervened) {
          intervened = true;
          const resolution = await suspendForHuman(error, step);
          humanActions.push(...resolution.humanActions);
          if (resolution.decision === "abort") throw error;

          // An operator who reviewed an irreversible step and chose to resume
          // has just *made* the decision the policy demanded. Without this the
          // retry re-fails the same gate and the run dies one line later, which
          // would make the console decorative for the very case it exists for.
          // Scoped to this run only — nothing is persisted back to the artifact.
          if (String(error.reason) === "irreversible_step") {
            approvedSteps.add(step.id);
            logger.warn(
              `[replay] ${resolution.operator ?? "an operator"} authorised the irreversible step ${step.id}`,
            );
          }

          logger.info(`[replay] resuming ${step.id} after ${resolution.humanActions.length} operator action(s)`);
          continue;
        }

        if (error instanceof Escalation) throw error;
        if (error instanceof HardFailure) {
          await captureFailureEvidence(`${step.id}-failed`);
          throw error;
        }
        throw error;
      }
    }
  }

  /**
   * Pause, cede the live session to a person, wait, take it back.
   *
   * The browser is never torn down and never replaced — same tab, same cookies,
   * same partially filled form. Ownership flips explicitly in both directions,
   * and evidence is captured *before* ceding, because once a human holds the
   * session automation cannot even screenshot it.
   */
  async function suspendForHuman(error: Escalation, step: Step): Promise<InterventionResolution> {
    await captureFailureEvidence(`${step.id}-escalation`);
    const session = await driver.cedeControl();

    const request: InterventionRequest = {
      interventionId: `iv_${runId}_${step.id}`,
      raisedAt: new Date().toISOString(),
      capabilityId: cap.id,
      capabilityVersion: cap.version,
      tenantId: cfg.tenant.tenantId,
      runId,
      goal: cap.description,
      atStepId: step.id,
      reason: String(error.reason),
      expected: `step "${step.id}" to complete: ${step.intent}`,
      observed: error.message,
      sessionId: session.sessionId,
      connectUrl: session.connectUrl,
    };

    try {
      return await input.onEscalation!(request, driver);
    } finally {
      await driver.resume();
    }
  }

  function maxRecoveryAttempts(stepId: string): number {
    return cap.recoveries
      .filter((r) => r.appliesTo === "all_steps" || r.appliesTo.includes(stepId))
      .reduce((max, r) => Math.max(max, r.maxAttempts), 1);
  }

  async function handleRecovery(rec: RecoverableCondition): Promise<void> {
    const handle = rec.handle;
    switch (handle.strategy) {
      case "wait":
        await new Promise((r) => setTimeout(r, handle.forMs));
        return;
      case "retry_step":
        await new Promise((r) => setTimeout(r, handle.backoffMs));
        return;
      case "run_steps":
        for (const sub of handle.steps) await performAction(sub as Step);
        return;
      case "reenter": {
        // Session expiry: re-run the flow from the declared step (typically the
        // login sequence), then let the caller retry the step that tripped.
        const from = handle.fromStepId;
        const start = from ? cap.flow.steps.findIndex((s) => s.id === from) : 0;
        for (const sub of cap.flow.steps.slice(Math.max(start, 0))) {
          if (sub.risk === "irreversible") break;
          await performAction(sub);
        }
        return;
      }
      case "escalate":
        throw new Escalation("recovery_exhausted" as never, "unknown");
    }
  }

  async function performAction(step: Step): Promise<void> {
    const action = step.action;
    const resolveIn = (s: string) => interpolate(s, scope);

    if (action.do === "navigate") {
      const url = resolveValue(action.url, scope);
      const gate = authorizeUrl(url, cfg.tenant);
      if (!gate.allowed) {
        throw new HardFailure(gate.code, "a URL inside the tenant allowlist", gate.reason, step.id);
      }
      await driver.navigate(url);
      return;
    }

    if (action.do === "press") return driver.press(action.keys);
    if (action.do === "wait_for") {
      const deadline = Date.now() + action.timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(action.until, actx)) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new HardFailure("WAIT_TIMEOUT", describe(action.until), `still false after ${action.timeoutMs}ms`, step.id);
    }
    if (action.do === "assert") {
      if (await evaluate(action.that, actx)) return;
      throw new HardFailure("ASSERTION_FAILED", describe(action.that), "did not hold", step.id);
    }

    const resolution = await resolveTarget(step, action.target, resolveIn);

    switch (action.do) {
      case "click":
        return driver.click(resolution);
      case "type":
        return driver.type(resolution, resolveValue(action.value, scope), {
          clearFirst: action.clearFirst,
        });
      case "select":
        return driver.select(resolution, resolveValue(action.value, scope));
      case "read": {
        let raw = await driver.read(resolution, action.source, action.attribute);

        /**
         * Existence is not readiness.
         *
         * On a client-rendered confirmation the element is in the DOM before the
         * value is written into it, so resolution succeeds and the read comes
         * back empty. Discovery never sees this: there is a model call between
         * every step, so the value has always landed by the time the recorder
         * looks. Replay runs in milliseconds and loses the race — the recorded
         * flow worked only because the recorder was slow.
         *
         * Only waited for when the binding feeds a *required* output, so a read
         * that may legitimately be empty is not charged the full timeout.
         */
        const feedsRequiredOutput = cap.contract.outputs.some(
          (o) => o.fromBinding === action.into && o.required,
        );
        if (feedsRequiredOutput && raw.trim() === "") {
          const deadline = Date.now() + step.timeoutMs;
          while (raw.trim() === "" && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 150));
            raw = await driver.read(resolution, action.source, action.attribute);
          }
        }

        scope.bindings.set(action.into, applyTransforms(raw, action.transforms));
        return;
      }
    }
  }

  async function resolveTarget(
    step: Step,
    locator: Parameters<SurfaceDriver["resolve"]>[0],
    resolveIn: (s: string) => string,
  ): Promise<Resolution> {
    const outcome = await driver.resolve(locator, resolveIn, { timeoutMs: step.timeoutMs });
    if (!outcome.ok) {
      const escalates = cap.escalation.on.includes(
        outcome.reason === "ambiguous" ? "locator_ambiguous" : "locator_unresolved",
      );
      if (escalates) {
        throw new Escalation(
          (outcome.reason === "ambiguous" ? "locator_ambiguous" : "locator_unresolved") as never,
          step.id,
        );
      }
      throw new HardFailure(
        outcome.reason === "ambiguous" ? "LOCATOR_AMBIGUOUS" : "LOCATOR_UNRESOLVED",
        `a unique match for ${locator.describe}`,
        outcome.tried.map((t) => `${t.strategy}:${t.matchCount}`).join(", ") || "no candidate matched",
        step.id,
      );
    }

    resolutions.push({
      locatorId: locator.id,
      stepId: step.id,
      resolvedByCandidate: outcome.resolution.candidateIndex,
      strategy: outcome.resolution.strategy,
      confidence: outcome.resolution.confidence,
      matchCount: outcome.resolution.matchCount,
      elapsedMs: outcome.resolution.elapsedMs,
    });
    return outcome.resolution;
  }
}
