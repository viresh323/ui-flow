import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SurfaceDriver } from "../surface/driver.js";
import { logger, redact } from "../obs/logger.js";
import type {
  HumanAction,
  Intervention,
  InterventionRequest,
  InterventionResolution,
} from "./types.js";
import { renderConsole, renderIndex } from "./ui.js";

/**
 * Operator console (§3.6).
 *
 * Scope note from the brief: a full real-time co-browsing console is out of
 * scope, but the handoff mechanism and the control-transfer model must be real.
 * So this is deliberately plain — a screenshot that refreshes, and click / type
 * / press controls — while everything underneath it is genuine:
 *
 *  - the operator drives the *same live browser session* the automation was
 *    using, not a copy and not a fresh one;
 *  - ownership is enforced by the driver, not by convention;
 *  - every action the human takes is recorded, redacted, and handed back to the
 *    run when they return control.
 *
 * Serving a screenshot and posting coordinates back is, incidentally, what a
 * real co-browsing console does too — it just does it at 30fps over WebRTC.
 */

export class OperatorConsole {
  private readonly interventions = new Map<string, Intervention>();
  private readonly waiters = new Map<string, (r: InterventionResolution) => void>();
  private readonly drivers = new Map<string, SurfaceDriver>();
  private readonly busy = new Set<string>();
  private server: Server | null = null;

  constructor(
    private readonly opts: { port: number; evidenceDir: string },
  ) {}

  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req.method ?? "GET", req.url ?? "/", req, res).catch((error) => {
          if (res.headersSent) return void res.end();
          // A mistake in the request is the operator's to fix and safe to say.
          // Anything else is ours: the detail goes to the log, and the caller
          // gets nothing to learn from.
          if (error instanceof BadRequest) {
            res.writeHead(400, { "content-type": "text/plain" });
            return void res.end(error.message);
          }
          logger.warn(`[operator] request failed: ${(error as Error).message}`);
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("the action failed; see the run log");
        });
      });
      // Without this a port already in use leaves the promise pending forever
      // (or crashes on an unhandled 'error' event) with no hint of the cause.
      this.server.once("error", (error) =>
        reject(new Error(`operator console cannot listen on 127.0.0.1:${this.opts.port}: ${(error as Error).message}`)),
      );
      // Loopback only. The console drives a live, authenticated browser session
      // and has no sign-in, so it must not be reachable from the network.
      this.server.listen(this.opts.port, "127.0.0.1", () => {
        const url = `http://127.0.0.1:${this.opts.port}`;
        logger.info(`[operator] console listening at ${url}`);
        resolve(url);
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => {
      if (!this.server) return r();
      this.server.close(() => r());
      // close() alone waits for keep-alive connections, so an operator tab left
      // open would hold the process up.
      this.server.closeAllConnections();
    });
  }

  /**
   * Raise an intervention and block until a human returns control.
   *
   * The run is *suspended*, not failed: the browser stays alive, the promise
   * stays pending, and the caller resumes exactly where it stopped. That is the
   * seam the brief asks for — automation pauses, cedes, and resumes on the same
   * session.
   */
  async raise(request: InterventionRequest, driver: SurfaceDriver): Promise<InterventionResolution> {
    const intervention: Intervention = {
      ...request,
      state: "pending",
      controller: "human",
      humanActions: [],
    };
    this.interventions.set(request.interventionId, intervention);
    this.drivers.set(request.interventionId, driver);

    logger.warn(
      `[operator] intervention ${request.interventionId} raised — ${request.reason} at ${request.atStepId}`,
    );
    logger.warn(
      `[operator] take control at http://127.0.0.1:${this.opts.port}/i/${request.interventionId}`,
    );

    const resolution = await new Promise<InterventionResolution>((resolve) => {
      this.waiters.set(request.interventionId, resolve);
    });

    // The session this intervention held is about to be handed back or closed;
    // keeping the reference would pin the browser for the life of the console.
    this.drivers.delete(request.interventionId);

    // The audit record outlives the process: who was called in, what they did,
    // and what the run did next. Written from a snapshot taken now, and a
    // failure to write it must not turn a successful handoff into a failed run.
    try {
      writeFileSync(
        join(this.opts.evidenceDir, `${request.interventionId}.json`),
        JSON.stringify(this.interventions.get(request.interventionId), null, 2),
      );
    } catch (error) {
      logger.warn(`[operator] could not write the audit record: ${(error as Error).message}`);
    }

    return resolution;
  }

  list(): Intervention[] {
    return [...this.interventions.values()];
  }

  /**
   * The console has no sign-in, so the only thing keeping it private is where it
   * is reachable from. Loopback binding keeps the network out; this keeps other
   * *web pages* out. A page the operator happens to have open can POST a form to
   * http://127.0.0.1:<port> without any preflight, and DNS rebinding can point
   * a hostile name at it. Requiring our own Host, and our own Origin on anything
   * that changes state, closes both.
   */
  private isOwnRequest(req: IncomingMessage, method: string): boolean {
    const own = new Set([`127.0.0.1:${this.opts.port}`, `localhost:${this.opts.port}`]);
    if (!own.has(String(req.headers.host ?? ""))) return false;
    const origin = req.headers.origin;
    if (method !== "GET" && origin !== undefined) return own.has(origin.replace(/^https?:\/\//, ""));
    return true;
  }

  private async handle(
    method: string,
    url: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const [path] = url.split("?");
    const send = (code: number, body: string, type = "text/html; charset=utf-8") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };

    if (!this.isOwnRequest(req, method)) return send(403, "forbidden", "text/plain");

    if (path === "/" || path === "/index.html") {
      return send(200, renderIndex(this.list()));
    }

    const match = /^\/i\/([\w-]+)(\/[a-z]+)?$/.exec(path ?? "");
    if (!match) return send(404, "not found", "text/plain");

    const id = match[1]!;
    const action = match[2];
    const intervention = this.interventions.get(id);
    if (!intervention) return send(404, "no such intervention", "text/plain");
    // Only present while the intervention is open; once it is resolved the
    // session belongs to the run again.
    const driver = this.drivers.get(id);
    const finished = intervention.state === "returned" || intervention.state === "aborted";

    if (!action && method === "GET") {
      return send(200, renderConsole(intervention, this.opts.port));
    }

    if (action === "/screenshot" && method === "GET") {
      if (!driver) return send(404, "the session is no longer held by the console", "text/plain");
      const png = Buffer.from(await driver.operatorScreenshot(), "base64");
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(png.byteLength),
        "cache-control": "no-store",
      });
      // The Buffer goes out as-is. Passing a latin1 *string* here instead —
      // which an earlier version did — makes Node encode it as UTF-8 on the way
      // out, so every byte above 0x7F becomes two and the PNG arrives corrupt.
      res.end(png);
      return;
    }

    if (action === "/act" && method === "POST") {
      // After a decision the run owns the session again. An action here would
      // land on a page the automation is driving, and would be written into an
      // audit record that has already been handed back.
      if (finished) return send(409, "this intervention is already finished", "text/plain");
      if (!driver) return send(404, "the session is no longer held by the console", "text/plain");
      // One action at a time: two overlapping requests (a double submit) would
      // interleave their clicks and keystrokes on the same page.
      if (this.busy.has(id)) return send(409, "another action is still running", "text/plain");

      const params = new URLSearchParams(await readBody(req));
      this.busy.add(id);
      try {
        await this.performHumanAction(intervention, driver, params);
      } finally {
        this.busy.delete(id);
      }
      // POST/redirect/GET so a browser refresh does not replay the action.
      res.writeHead(303, { location: `/i/${id}` });
      res.end();
      return;
    }

    if (action === "/finish" && method === "POST") {
      // A second decision (a double click, a retry) must not overwrite the first:
      // the run has already acted on it, and the record would then disagree.
      if (finished) return send(409, "this intervention is already finished", "text/plain");
      if (this.busy.has(id)) return send(409, "an action is still running; try again", "text/plain");

      const params = new URLSearchParams(await readBody(req));
      const decision = params.get("decision") === "abort" ? "abort" : "resume";
      intervention.state = decision === "abort" ? "aborted" : "returned";
      intervention.controller = "automation";
      intervention.resolvedAt = new Date().toISOString();

      const waiter = this.waiters.get(id);
      this.waiters.delete(id);
      waiter?.({ decision, humanActions: intervention.humanActions, operator: intervention.operator });

      logger.info(`[operator] intervention ${id} ${intervention.state} after ${intervention.humanActions.length} action(s)`);
      res.writeHead(303, { location: "/" });
      res.end();
      return;
    }

    // Unknown verb on a known intervention — ignore rather than guess.
    return send(405, "unsupported", "text/plain");
  }

  /**
   * Perform one operator action on the live session and record it.
   *
   * Recording is the half that is easy to forget and that the brief asks for
   * explicitly. A typed value is stored only when the operator marks it
   * non-sensitive; otherwise we keep the fact and the place, never the value.
   */
  private async performHumanAction(
    intervention: Intervention,
    driver: SurfaceDriver,
    params: URLSearchParams,
  ): Promise<void> {
    // Validate first. A malformed request must not claim the intervention or
    // leave a half-made record behind: an empty x used to become 0 and click the
    // top-left corner of the page.
    const kind = params.get("kind");
    if (!kind || !ACTION_KINDS.has(kind)) throw new BadRequest("unknown action kind");
    const k = kind as HumanAction["kind"];

    let x = 0;
    let y = 0;
    if (k === "click") {
      const xs = params.get("x");
      const ys = params.get("y");
      x = xs === null || xs.trim() === "" ? NaN : Number(xs);
      y = ys === null || ys.trim() === "" ? NaN : Number(ys);
      if (![x, y].every((n) => Number.isFinite(n) && n >= 0 && n <= 20_000)) {
        throw new BadRequest("click needs numeric x and y");
      }
    }
    const value = params.get("value") ?? "";
    if (value.length > 2_000) throw new BadRequest("value is too long");
    const keys = params.get("keys") || "Enter";
    if (k === "press" && !/^[A-Za-z0-9+]{1,30}$/.test(keys)) throw new BadRequest("unknown key");
    if ((k === "type" || k === "navigate") && value === "") throw new BadRequest("a value is required");

    const operator = params.get("operator")?.trim() || intervention.operator || "unidentified-operator";
    if (intervention.state === "pending") {
      intervention.state = "claimed";
      intervention.operator = operator;
      intervention.claimedAt = new Date().toISOString();
      logger.info(`[operator] ${operator} claimed ${intervention.interventionId}`);
    }

    const record: HumanAction = { at: new Date().toISOString(), operator, kind: k, urlAfter: "" };

    switch (k) {
      case "click":
        await driver.operatorClick(x, y);
        record.at_xy = { x, y };
        break;
      case "type":
        await driver.operatorType(value);
        record.value = params.get("sensitive") === "on" ? "[redacted by operator]" : redact(value);
        break;
      case "press":
        await driver.operatorPress(keys);
        record.value = keys;
        break;
      case "navigate":
        await driver.operatorNavigate(value);
        record.value = redact(value);
        break;
      case "note":
        record.value = redact(value);
        break;
    }

    // A session id or token in the address must not reach the audit record.
    record.urlAfter = redact(driver.operatorUrl());
    intervention.humanActions.push(record);
  }
}

const ACTION_KINDS = new Set(["click", "type", "press", "navigate", "note"]);

/** A request the operator got wrong, as opposed to a failure of ours. */
class BadRequest extends Error {}

async function readBody(req: IncomingMessage, max = 64_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new BadRequest("request body is too large");
    chunks.push(Buffer.from(c as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function newInterventionId(): string {
  return `iv_${Date.now().toString(36)}_${randomUUID().slice(0, 4)}`;
}
