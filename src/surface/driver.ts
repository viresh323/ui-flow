import type { Locator } from "../artifact/index.js";
import type { HarvestedTarget } from "../discovery/harvest.js";
import type { Controller } from "../escalation/types.js";

/**
 * The surface seam (§3.7).
 *
 * Everything above this line — the artifact schema, the replay engine, the
 * error taxonomy, the discovery loop, escalation — is written against this
 * interface and never imports Playwright. A Windows UI Automation driver
 * implements the same verbs; only the locator strategies it can honour differ.
 *
 * The verbs are deliberately the ones a human operator would recognise, because
 * that is the level at which a recorded flow stays true across surfaces. "Click
 * the control named Log In" survives a port to a desktop app; "dispatch a
 * pointer event at (340, 210)" does not.
 */

export type SurfaceKind = "web" | "desktop_uia" | "terminal";

export interface Observation {
  url: string;
  title: string;
  /**
   * A compact semantic rendering of what is on screen — the accessibility tree,
   * not raw markup. This is what the model reasons over during discovery, and
   * it is the representation a desktop surface can also produce.
   */
  tree: string;
  /** base64 PNG. Optional: evidence always, model input only when vision is on. */
  screenshot?: string;
}

/** What resolving a locator bundle actually produced. */
export interface Resolution {
  /** Opaque driver-side handle for the matched element. */
  handle: unknown;
  /** Index into the candidate bundle that won — the drift signal (see result.ts). */
  candidateIndex: number;
  strategy: string;
  confidence: number;
  matchCount: number;
  elapsedMs: number;
}

export type ResolveOutcome =
  | { ok: true; resolution: Resolution }
  | { ok: false; reason: "not_found" | "ambiguous"; tried: Array<{ strategy: string; matchCount: number }> };

/**
 * A live session that outlives any single run (§3.6). Automation can stop
 * driving it, a human can drive it, and automation can resume — same tab, same
 * cookies, same half-filled form.
 */
export interface SessionHandle {
  sessionId: string;
  /** Where a human operator connects to take control. */
  connectUrl: string;
}

export interface SurfaceDriver {
  readonly surface: SurfaceKind;
  readonly sessionId: string;

  start(): Promise<SessionHandle>;
  close(): Promise<void>;

  navigate(url: string): Promise<void>;
  observe(opts?: { screenshot?: boolean }): Promise<Observation>;
  screenshot(): Promise<string>;

  /**
   * @param opts.timeoutMs how long to keep retrying the bundle before giving
   *   up. Action targets get the step budget; detectors that ask "is this
   *   absent?" pass 0, since waiting for an absence is just a slow false.
   */
  resolve(
    locator: Locator,
    interpolate: (s: string) => string,
    opts?: { timeoutMs?: number },
  ): Promise<ResolveOutcome>;

  /**
   * Discovery only: resolve a [ref=eN] handle from the most recent observation.
   * Refs are snapshot-scoped and meaningless later — they exist so the model can
   * point at something concrete, never to be recorded into an artifact.
   */
  resolveRef(ref: string): Promise<Resolution | null>;

  /**
   * Inspect a resolved element for the durable identifiers a locator bundle is
   * built from. A desktop driver answers this from UIA (AutomationId, Name,
   * ControlType, containing grid) rather than the DOM.
   */
  describeTarget(r: Resolution): Promise<HarvestedTarget>;

  click(r: Resolution): Promise<void>;
  type(r: Resolution, value: string, opts?: { clearFirst?: boolean }): Promise<void>;
  select(r: Resolution, value: string): Promise<void>;
  press(keys: string): Promise<void>;
  read(r: Resolution, source: "text" | "value" | "attribute", attribute?: string): Promise<string>;

  /** Text currently visible anywhere on the surface — backs `text_matches`. */
  visibleText(): Promise<string>;

  /**
   * Stop driving without tearing down. The session stays alive and reachable at
   * `connectUrl` so a human can take over. Automation must not touch the
   * surface again until `resume()`.
   */
  cedeControl(): Promise<SessionHandle>;
  resume(): Promise<void>;
  /** Who may act right now. Single-valued on purpose. */
  controller(): Controller;

  /**
   * Entry points usable ONLY while a human holds control — the mirror image of
   * every method above, which throw in that state. Coordinates rather than
   * locators, because an operator points at what they see; the point of calling
   * a human in is that semantic targeting has already failed.
   */
  operatorClick(x: number, y: number): Promise<void>;
  operatorType(text: string): Promise<void>;
  operatorPress(keys: string): Promise<void>;
  operatorNavigate(url: string): Promise<void>;
  operatorScreenshot(): Promise<string>;
  operatorUrl(): string;
}

export class NotImplemented extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet (skeleton)`);
    this.name = "NotImplemented";
  }
}
