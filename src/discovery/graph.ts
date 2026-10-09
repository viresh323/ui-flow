import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { DiscoveryCtx } from "./types.js";
import { prepare } from "./stages/01-prepare.js";
import { observe } from "./stages/02-observe.js";
import { decide } from "./stages/03-decide.js";
import { act } from "./stages/04-act.js";
import { compileArtifact } from "./stages/05-compile.js";
import { escalate } from "./stages/06-escalate.js";
import { mergeUsage } from "../providers/aiProvider.js";
import { logger } from "../obs/logger.js";

/**
 * The discovery pipeline (§3.1), as a LangGraph state machine.
 *
 * Three reasons this is a graph rather than a `while` loop:
 *
 *  1. Checkpointing. Every node boundary commits state to sqlite, so a run that
 *     dies — crash, timeout, rate limit — resumes from the last completed node
 *     instead of re-driving the UI from scratch and re-spending tokens.
 *  2. Escalation (§3.6). "Pause, let a human act, resume on the same session" is
 *     exactly a durable interrupt. The checkpoint holds the run; the live
 *     browser holds the session; `resumeAsNode` decides where to re-enter.
 *  3. Testability. Stages stay plain functions over ctx.
 */

const PipelineState = Annotation.Root({
  ctx: Annotation<DiscoveryCtx>({
    reducer: (existing, update) => ({ ...existing, ...update }),
    default: () => ({}) as DiscoveryCtx,
  }),
});

/** Wrap a stage into a node with logging and per-stage usage attribution. */
function node(name: string, fn: (ctx: DiscoveryCtx) => Promise<DiscoveryCtx>) {
  return async (state: { ctx: DiscoveryCtx }) => {
    logger.info(`--- stage: ${name} ---`);
    const before = state.ctx.usage;
    const ctx = await fn(state.ctx);

    const spent = {
      inputTokens: ctx.usage.inputTokens - before.inputTokens,
      outputTokens: ctx.usage.outputTokens - before.outputTokens,
      totalTokens: ctx.usage.totalTokens - before.totalTokens,
      requests: ctx.usage.requests - before.requests,
    };
    if (spent.requests > 0) {
      logger.info(`[${name}] ${spent.requests} req | in ${spent.inputTokens} | out ${spent.outputTokens}`);
    }

    return {
      ctx: {
        ...ctx,
        usageByStage: { ...ctx.usageByStage, [name]: mergeUsage(ctx.usageByStage[name] ?? null, spent) },
      },
    };
  };
}

/**
 * After `decide`, three ways out. This is where the stopping conditions the
 * brief asks for actually live — max steps, dead end, goal met.
 */
function routeAfterDecide(state: { ctx: DiscoveryCtx }): "act" | "compile" | "escalate" {
  const { decision, stepIndex, cfg } = state.ctx;

  if (decision?.kind === "done") return "compile";
  if (decision?.kind === "stuck") return "escalate";
  if (stepIndex >= cfg.maxSteps) {
    logger.warn(`[route] step budget of ${cfg.maxSteps} exhausted — escalating`);
    return "escalate";
  }
  return "act";
}

/**
 * A refused entry point leaves the browser unstarted. Carrying on into `observe`
 * would call a driver that does not exist and bury the real reason
 * (PATH_NOT_ALLOWED) under a driver exception, so a failed prepare ends the run.
 */
function routeAfterPrepare(state: { ctx: DiscoveryCtx }): "observe" | typeof END {
  return state.ctx.status === "failed" ? END : "observe";
}

/** After `act`, loop back to observe unless the action itself failed hard. */
function routeAfterAct(state: { ctx: DiscoveryCtx }): "observe" | "escalate" {
  return state.ctx.status === "failed" ? "escalate" : "observe";
}

export function buildDiscoveryGraph(checkpointer: SqliteSaver) {
  return new StateGraph(PipelineState)
    .addNode("prepare", node("prepare", prepare))
    .addNode("observe", node("observe", observe))
    .addNode("decide", node("decide", decide))
    .addNode("act", node("act", act))
    .addNode("compile", node("compile", compileArtifact))
    .addNode("escalate", node("escalate", escalate))
    .addEdge(START, "prepare")
    .addConditionalEdges("prepare", routeAfterPrepare, ["observe", END])
    .addEdge("observe", "decide")
    .addConditionalEdges("decide", routeAfterDecide, ["act", "compile", "escalate"])
    .addConditionalEdges("act", routeAfterAct, ["observe", "escalate"])
    .addEdge("compile", END)
    .addEdge("escalate", END)
    .compile({ checkpointer });
}

/**
 * One thread per run so a resumed run picks up its own checkpoint. Keyed by
 * goal as well as runId because the same session may discover several
 * capabilities in sequence.
 */
export function threadId(runId: string, capabilityId: string): string {
  return `${runId}:${capabilityId}`;
}

export function openCheckpointer(dbPath: string): SqliteSaver {
  // runs/ is git-ignored, so on a fresh clone it does not exist, and SQLite will
  // not create a missing directory: discovery died on its first line.
  mkdirSync(dirname(dbPath), { recursive: true });
  return SqliteSaver.fromConnString(dbPath);
}

export async function runDiscovery(ctx: DiscoveryCtx, capabilityId: string): Promise<DiscoveryCtx> {
  const checkpointer = openCheckpointer(ctx.cfg.checkpointDb);
  const app = buildDiscoveryGraph(checkpointer);
  const config = {
    configurable: { thread_id: threadId(ctx.runId, capabilityId) },
    // Each loop turn is three nodes (observe -> decide -> act) plus the
    // prepare/compile bookends, so the graph budget has to track maxSteps or
    // the run dies of recursion before it reaches its own stopping condition.
    recursionLimit: ctx.cfg.maxSteps * 3 + 10,
  };

  const final = await app.invoke({ ctx }, config);
  return final.ctx;
}
