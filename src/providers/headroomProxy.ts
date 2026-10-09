import { spawn } from "node:child_process";
import { logger } from "../obs/logger.js";

/**
 * Lifecycle for the Headroom compression proxy (ported from
 * buildasign-dev-agent's services/headroomProxy.js).
 *
 * Never throws and never blocks a run: if the proxy cannot be reached or
 * started, compressPrompt sends the prompt uncompressed and the only cost is
 * the saving we missed.
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:8799";
/** Cold start is ~20s on Windows (uvicorn plus the compressor models). */
const DEFAULT_START_TIMEOUT_MS = 60_000;
/**
 * "token" rather than Headroom's own "cache" default: nothing here routes model
 * traffic through the proxy, so there is no provider prefix cache to protect and
 * no prior turns to freeze. One prompt in, one out — "token" is the mode that
 * actually compresses.
 */
const DEFAULT_MODE = "token";
const HEALTH_TIMEOUT_MS = 1_500;
const POLL_INTERVAL_MS = 500;

let attempt: Promise<{ running: boolean; started: boolean }> | null = null;

export function proxyBaseUrl(): string {
  return (process.env.HEADROOM_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function proxyPort(): number {
  const port = Number.parseInt(new URL(proxyBaseUrl()).port, 10);
  return Number.isFinite(port) ? port : 8799;
}

async function isHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${proxyBaseUrl()}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function spawnProxy(): void {
  const command = process.env.HEADROOM_CMD?.trim() || "headroom";
  const mode = process.env.HEADROOM_MODE?.trim() || DEFAULT_MODE;
  const child = spawn(command, ["proxy", "--port", String(proxyPort()), "--mode", mode], {
    detached: true,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  child.on("error", (error) => logger.warn(`[headroom] could not launch "${command}": ${error.message}`));
  child.unref();
}

/** Called once at startup. Idempotent per process. */
export function ensureProxyRunning(): Promise<{ running: boolean; started: boolean }> {
  attempt ??= (async () => {
    if (await isHealthy()) {
      logger.info(`[headroom] proxy already running at ${proxyBaseUrl()}`);
      return { running: true, started: false };
    }

    if (process.env.HEADROOM_AUTOSTART === "false") {
      logger.warn(`[headroom] no proxy at ${proxyBaseUrl()} and autostart disabled — prompts go uncompressed`);
      return { running: false, started: false };
    }

    logger.info(`[headroom] starting compression proxy on port ${proxyPort()}`);
    spawnProxy();

    const deadline = Date.now() + DEFAULT_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      if (await isHealthy()) {
        logger.info(`[headroom] proxy ready at ${proxyBaseUrl()}`);
        return { running: true, started: true };
      }
    }

    logger.warn("[headroom] proxy did not come up in time — prompts go uncompressed");
    return { running: false, started: true };
  })();

  return attempt;
}

/** Test seam: forget the one-shot result so the next call probes again. */
export function resetProxyState(): void {
  attempt = null;
}
