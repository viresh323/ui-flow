import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { config as loadEnv } from "dotenv";

/**
 * Demo UI. A thin shell over the real CLI.
 *
 * It deliberately does not re-implement discovery or replay: each run is the
 * same `src/index.ts` command a person would type, started as a child process.
 * That keeps the UI honest — what it shows is what the engine did — and keeps
 * the engine free of UI concerns (global logger and secret state stay isolated
 * per run).
 *
 * Three things come out of the child:
 *   - stderr log lines  -> streamed to the page as they happen (already redacted)
 *   - stdout            -> the replay result JSON, parsed when the run ends
 *   - the CDP port      -> printed in a log line; used to grab live frames of the
 *                          browser the run is driving, read-only
 *
 * Bound to 127.0.0.1 and never reads secrets: it does not expose .env, and the
 * only file paths it will serve are capability JSON under examples/ and runs/.
 */

loadEnv({ quiet: true });

const ROOT = process.cwd();
const PORT = Number(process.env.UI_PORT ?? 8801);
const OPERATOR_PORT = 8790;
const PAGE = join(ROOT, "src", "ui", "index.html");

// ---------------------------------------------------------------------------
// artifacts

interface ArtifactSummary {
  path: string;
  id: string;
  name: string;
  version: string;
  source: "hand-written" | "discovered";
  model?: string;
  recordedAt?: string;
  reviewStatus?: string;
  stepCount: number;
  maxRisk?: string;
  inputs: Array<{ name: string; type: string; required: boolean; description?: string; example?: string }>;
  outputs: string[];
  outcomes: string[];
  mtime: number;
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth < 0 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, depth - 1, out);
    else if (entry.name.endsWith(".json") && entry.name !== "trace.json" && entry.name !== "run-meta.json") {
      out.push(p);
    }
  }
}

const posix = (p: string): string => relative(ROOT, p).split(sep).join("/");

/** Only capability JSON under examples/ or runs/ is ever readable through the UI. */
function safeArtifactPath(rel: string): string | null {
  if (!/^(examples|runs)\/[\w./-]+\.json$/.test(rel) || rel.includes("..")) return null;
  // The listing hides run traces; reading them by path would sidestep that.
  if (/(^|\/)(trace|run-meta)\.json$/.test(rel)) return null;
  const abs = resolve(ROOT, rel);
  if (!abs.startsWith(ROOT + sep) || !existsSync(abs)) return null;
  // A link under examples/ or runs/ must not lead outside the project.
  const real = realpathSync(abs);
  if (!real.startsWith(realpathSync(ROOT) + sep)) return null;
  return abs;
}

function listArtifacts(): ArtifactSummary[] {
  const files: string[] = [];
  walk(join(ROOT, "examples"), 3, files);
  walk(join(ROOT, "runs"), 3, files);
  const out: ArtifactSummary[] = [];
  for (const file of files) {
    try {
      if (statSync(file).size > 2_000_000) continue;
      const c = JSON.parse(readFileSync(file, "utf8"));
      if (c?.kind !== "capability") continue;
      const rel = posix(file);
      const inputs = (c.contract?.inputs ?? []).map((i: Record<string, any>) => ({
        name: String(i.name),
        type: String(i.type?.kind ?? "string"),
        required: Boolean(i.required),
        description: i.description,
        // Discovery records the value it saw ("observed as \"12345\"").
        example: /"([^"]+)"/.exec(String(i.description ?? ""))?.[1],
      }));
      out.push({
        path: rel,
        id: c.id,
        name: c.name,
        version: c.version,
        source: rel === "examples/read_account_balance.json" ? "hand-written" : "discovered",
        model: c.provenance?.model,
        recordedAt: c.provenance?.recordedAt,
        reviewStatus: c.provenance?.review?.status,
        stepCount: c.flow?.steps?.length ?? 0,
        maxRisk: c.policy?.maxRisk,
        inputs,
        outputs: (c.contract?.outputs ?? []).map((o: Record<string, any>) => String(o.name)),
        outcomes: (c.contract?.outcomes ?? []).map((o: Record<string, any>) => String(o.code)),
        mtime: statSync(file).mtimeMs,
      });
    } catch {
      /* not a capability, or unreadable — skip */
    }
  }
  return out.sort((a, b) => (a.source === b.source ? b.mtime - a.mtime : a.source === "hand-written" ? -1 : 1));
}

// ---------------------------------------------------------------------------
// live frames over CDP

/**
 * Read-only screenshots of the browser a child run is driving. A second CDP
 * client is harmless to Playwright, and it works whoever currently owns the
 * session (automation or a human operator).
 */
class CdpShooter {
  private ws: any = null;
  private nextId = 1;
  private readonly pending = new Map<number, (m: any) => void>();
  private connecting: Promise<void> | null = null;
  private inflight: Promise<Buffer | null> | null = null;
  private closed = false;
  last: { buf: Buffer; at: number } | null = null;

  constructor(readonly port: number) {}

  private async connect(): Promise<void> {
    // Neither step may wait forever: a hung connect would leave `connecting` and
    // `inflight` set, and every later frame request would join the same stuck
    // promise.
    const targets = (await (
      await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(2000) })
    ).json()) as Array<Record<string, string>>;
    const page = targets.find((t) => t.type === "page");
    if (!page?.webSocketDebuggerUrl) throw new Error("no page target yet");
    const WS = (globalThis as any).WebSocket;
    const ws = new WS(page.webSocketDebuggerUrl);
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* never opened */
        }
        fail(new Error("cdp socket timed out"));
      }, 3000);
      ws.onopen = () => {
        clearTimeout(timer);
        ok();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        fail(new Error("cdp socket error"));
      };
    });
    ws.onmessage = (e: { data: string }) => {
      const m = JSON.parse(String(e.data));
      this.pending.get(m.id)?.(m);
      this.pending.delete(m.id);
    };
    ws.onclose = () => {
      this.ws = null;
      // Requests already sent will never be answered; fail them now rather than
      // letting each wait out its own timeout.
      for (const answer of this.pending.values()) answer({ error: { message: "cdp socket closed" } });
      this.pending.clear();
    };
    this.ws = ws;
  }

  private send(method: string, params: object): Promise<any> {
    return new Promise((ok, fail) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error("cdp timeout"));
      }, 4000);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        m.error ? fail(new Error(m.error.message)) : ok(m.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Keep capturing while the run is alive. Replays last a few seconds, so
   * waiting for the page to ask would miss the screen the run ends on; with
   * this running, the last frame served is within a fraction of a second of it.
   */
  pump(): void {
    void (async () => {
      while (!this.closed) {
        await this.frame();
        await new Promise((r) => setTimeout(r, 120));
      }
    })();
  }

  /** At most one capture in flight; callers inside 120ms share the last one. */
  frame(): Promise<Buffer | null> {
    if (this.closed) return Promise.resolve(this.last?.buf ?? null);
    if (this.last && Date.now() - this.last.at < 120) return Promise.resolve(this.last.buf);
    this.inflight ??= (async () => {
      try {
        if (!this.ws) await (this.connecting ??= this.connect().finally(() => (this.connecting = null)));
        const r = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
        this.last = { buf: Buffer.from(r.data, "base64"), at: Date.now() };
        return this.last.buf;
      } catch (e) {
        if (process.env.UI_DEBUG) process.stderr.write(`[frame] ${(e as Error).message}\n`);
        return this.last?.buf ?? null;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// the single active run

type Ev = { n: number; t: number; kind: string; [k: string]: unknown };

interface Run {
  id: string;
  /** Monotonic event counter. Not the array length: the buffer is trimmed. */
  seq: number;
  mode: "discover" | "replay";
  label: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "ended" | "stopped";
  events: Ev[];
  child?: ChildProcess;
  shooter?: CdpShooter;
  stdout: string;
  stderrTail: string;
  artifactPath?: string;
}

let run: Run | null = null;
const clients = new Set<ServerResponse>();

function push(r: Run, kind: string, data: Record<string, unknown> = {}): void {
  // A run that is no longer the current one (stopped, then replaced) must not
  // speak to the page: its late `end` would be read as the new run's.
  if (r !== run) return;
  // The page drops any event whose n it has already seen, so n must only ever
  // grow. Taking it from the array length reused numbers after a trim, and the
  // page then ignored the next thousand events, `end` among them.
  const ev: Ev = { n: r.seq++, t: Date.now(), kind, ...data };
  r.events.push(ev);
  // Trim the middle and keep event 0, `start`: a page that connects later needs
  // it to know a run is in progress at all.
  if (r.events.length > 4000) r.events.splice(1, 1000);
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.write(line);
}

const LOG_LINE = /^(\d\d:\d\d:\d\d) (debug|info|warn|error)\s+(.*)$/;

function onStderrLine(r: Run, raw: string): void {
  const line = raw.replace(/\r$/, "");
  if (!line.trim()) return;
  const m = LOG_LINE.exec(line);
  const level = m?.[2] ?? "info";
  // One enormous line must not be held, and replayed to every page, in full.
  const msg = (m?.[3] ?? line).slice(0, 4000);
  push(r, "log", { level, msg });

  const cdp = /\(cdp :(\d+)\)/.exec(msg);
  if (cdp && !r.shooter) {
    r.shooter = new CdpShooter(Number(cdp[1]));
    r.shooter.pump();
  }

  const handoff = /take control at (http:\/\/127\.0\.0\.1:\d+\/i\/[\w-]+)/.exec(msg);
  if (handoff) push(r, "handoff", { url: handoff[1] });
  if (/\[operator\] intervention \S+ (returned|aborted)/.test(msg)) push(r, "handoff_end");

  const wrote = /\[compile\] wrote (\S+\.json)/.exec(msg);
  if (wrote) {
    r.artifactPath = wrote[1]!.replace(/\\/g, "/");
    push(r, "artifact", { path: r.artifactPath });
  }
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 64_000) {
        fail(new Error("body too large"));
        req.destroy();
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        ok(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        fail(e);
      }
    });
    req.on("error", fail);
  });
}

function paramArgs(params: unknown): string[] {
  const out: string[] = [];
  if (params && typeof params === "object") {
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      if (!/^\w{1,64}$/.test(k)) throw new Error(`bad parameter name: ${k}`);
      const val = String(v ?? "");
      if (val.length > 200) throw new Error(`parameter ${k} is too long`);
      if (val !== "") out.push(`${k}=${val}`);
    }
  }
  return out;
}

/**
 * The operator console needs a port of its own. A fixed one collides with a
 * console someone already has open (or a run that was suspended and forgotten),
 * so take the first free port from 8790 up, skipping 8799 (Headroom's).
 */
async function freeOperatorPort(): Promise<number> {
  const { createServer: net } = await import("node:net");
  for (let p = OPERATOR_PORT; p < 8799; p++) {
    const free = await new Promise<boolean>((ok) => {
      const s = net();
      s.once("error", () => ok(false));
      // No host: bind exactly as OperatorConsole does, or an IPv6 listener
      // on the same port goes unnoticed.
      s.listen(p, () => s.close(() => ok(true)));
    });
    if (free) return p;
  }
  throw new Error("no free port for the operator console");
}

let starting = false;

/**
 * Taking the operator port is async, so there is a gap between "is a run in
 * progress?" and `run = r`. Two requests landing in that gap would both start a
 * browser. The flag closes it: it is set before the first await.
 */
async function startRun(body: any): Promise<Run> {
  if (starting || run?.status === "running") {
    throw Object.assign(new Error("a run is already in progress"), { code: 409 });
  }
  starting = true;
  try {
    return await startRunLocked(body);
  } finally {
    starting = false;
  }
}

async function startRunLocked(body: any): Promise<Run> {
  const args = ["--import", "tsx", "src/index.ts"];
  let label: string;
  const params = paramArgs(body.params);

  if (body.mode === "discover") {
    const goal = String(body.goal ?? "").trim();
    const capabilityId = String(body.capabilityId ?? "").trim();
    if (!goal || goal.length > 600) throw new Error("goal is required (600 characters at most)");
    if (!/^[\w-]{1,64}$/.test(capabilityId)) throw new Error("capability id: letters, digits, _ and - only");
    args.push("discover", "--goal", goal, "--capability-id", capabilityId);
    if (params.length) args.push("--param", ...params);
    label = goal;
  } else if (body.mode === "replay") {
    const rel = String(body.artifact ?? "");
    if (!safeArtifactPath(rel)) throw new Error("unknown artifact");
    args.push("replay", "--artifact", rel);
    if (params.length) args.push("--param", ...params);
    if (body.handoff) args.push("--operator", String(await freeOperatorPort()));
    label = rel;
  } else {
    throw new Error("mode must be discover or replay");
  }

  const r: Run = {
    id: `ui_${Date.now().toString(36)}`,
    seq: 0,
    mode: body.mode,
    label,
    startedAt: Date.now(),
    status: "running",
    events: [],
    stdout: "",
    stderrTail: "",
  };
  run = r;

  // Headless by default so the browser is seen once, in the page. The window
  // can be shown too when someone wants to see the real thing.
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, HEADLESS: body.showWindow ? "false" : "true", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  r.child = child;
  push(r, "start", { mode: r.mode, label: r.label, handoff: Boolean(body.handoff) });

  child.stdout!.on("data", (d: Buffer) => {
    // The replay result is a few KB. Anything near this cap is not a result.
    if (r.stdout.length < 2_000_000) r.stdout += d.toString("utf8");
  });
  child.stderr!.on("data", (d: Buffer) => {
    r.stderrTail += d.toString("utf8");
    const lines = r.stderrTail.split("\n");
    r.stderrTail = (lines.pop() ?? "").slice(-64_000);
    for (const l of lines) onStderrLine(r, l);
  });
  child.on("error", (e) => push(r, "log", { level: "error", msg: `could not start the run: ${e.message}` }));
  child.on("close", (code) => {
    if (r.stderrTail) onStderrLine(r, r.stderrTail);
    r.endedAt = Date.now();
    if (r.status === "running") r.status = "ended";
    let result: unknown;
    if (r.mode === "replay") {
      try {
        result = JSON.parse(r.stdout);
      } catch {
        /* no result payload — the log says why */
      }
    }
    push(r, "end", { code, stopped: r.status === "stopped", result, artifactPath: r.artifactPath });
    // keep the last frame for the page; stop talking to a browser that is gone
    setTimeout(() => r.shooter?.close(), 500);
  });

  return r;
}

function stopRun(): boolean {
  if (!run || run.status !== "running" || !run.child?.pid) return false;
  run.status = "stopped";
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(run.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    run.child.kill("SIGTERM");
  }
  return true;
}

// ---------------------------------------------------------------------------
// http

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * Loopback binding keeps the network out; this keeps other *web pages* out. A
 * page the person happens to have open can fire a cross-origin POST at
 * http://127.0.0.1:8801/api/run with no preflight and start a discovery run on
 * their credentials and quota, and DNS rebinding can point a hostile name at
 * this port. Requiring our own Host, and our own Origin when one is sent, ends
 * both.
 */
function isOwnRequest(req: IncomingMessage): boolean {
  const own = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  if (!own.has(String(req.headers.host ?? ""))) return false;
  const origin = req.headers.origin;
  return origin === undefined || own.has(origin.replace(/^https?:\/\//, ""));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (!isOwnRequest(req)) return json(res, 403, { error: "forbidden" });
  if (method === "POST" && path === "/api/run" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    return json(res, 415, { error: "send application/json" });
  }

  if (method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(readFileSync(PAGE));
    return;
  }

  if (method === "GET" && path === "/api/info") {
    return json(res, 200, {
      provider: process.env.AI_PROVIDER ?? "gemini",
      model: process.env.AI_MODEL || "provider default",
      operatorPort: OPERATOR_PORT,
      running: run?.status === "running",
    });
  }

  if (method === "GET" && path === "/api/artifacts") return json(res, 200, listArtifacts());

  if (method === "GET" && path === "/api/artifact") {
    const abs = safeArtifactPath(url.searchParams.get("path") ?? "");
    if (!abs) return json(res, 404, { error: "unknown artifact" });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(readFileSync(abs));
    return;
  }

  if (method === "POST" && path === "/api/run") {
    try {
      const r = await startRun(await readJsonBody(req));
      return json(res, 200, { id: r.id });
    } catch (e) {
      return json(res, (e as { code?: number }).code ?? 400, { error: (e as Error).message });
    }
  }

  if (method === "POST" && path === "/api/stop") return json(res, 200, { stopped: stopRun() });

  // A reconnecting page is shown the last run again, which is right after a
  // refresh and wrong at the start of a recording. This forgets it.
  if (method === "POST" && path === "/api/reset") {
    if (run?.status === "running") return json(res, 409, { error: "a run is in progress; stop it first" });
    run = null;
    for (const c of clients) c.write(`data: ${JSON.stringify({ kind: "reset" })}\n\n`);
    return json(res, 200, { ok: true });
  }

  if (method === "GET" && path === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(`retry: 2000\n\n`);
    // A reconnecting page gets the whole run again, so a refresh mid-demo is safe.
    for (const ev of run?.events ?? []) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    clients.add(res);
    const beat = setInterval(() => res.write(`: keepalive\n\n`), 15_000);
    req.on("close", () => {
      clearInterval(beat);
      clients.delete(res);
    });
    return;
  }

  if (method === "GET" && path === "/api/frame") {
    const buf = (await run?.shooter?.frame()) ?? null;
    if (!buf) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(buf.length), "cache-control": "no-store" });
    res.end(buf);
    return;
  }

  json(res, 404, { error: "not found" });
}

createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) json(res, 500, { error: (e as Error).message });
    else res.end();
  });
}).listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`UIFlow demo UI: http://127.0.0.1:${PORT}\n`);
});

process.on("SIGINT", () => {
  stopRun();
  process.exit(0);
});
