import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, ElementHandle, Frame, Locator as PwLocator, Page } from "playwright";
import type { Locator } from "../artifact/index.js";
import type {
  Observation,
  Resolution,
  ResolveOutcome,
  SessionHandle,
  SurfaceDriver,
  SurfaceKind,
} from "./driver.js";
import { matchLabelProximity, matchNearAnchor, matchTableCell, roleSelector } from "./strategies.js";
import { describeElement, type HarvestedTarget } from "../discovery/harvest.js";
import type { Controller } from "../escalation/types.js";
import { logger } from "../obs/logger.js";

/**
 * Web surface driver.
 *
 * Playwright is confined to this file. It is chosen over a simpler HTTP client
 * for one decisive reason: §3.6 requires a human to take control of the *same
 * live session*, which means a real browser that stays alive while automation
 * stops driving it. A headless fetch loop cannot cede control to a person.
 */
export class PlaywrightDriver implements SurfaceDriver {
  readonly surface: SurfaceKind = "web";
  readonly sessionId = randomUUID();

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private controlledByHuman = false;
  /** The remote-debugging port this session actually bound. Set by start(). */
  private cdpPort = 0;

  constructor(
    private readonly opts: {
      headless: boolean;
      baseUrl: string;
      cdpPort?: number;
      /**
       * Called for every navigation the page attempts, whoever caused it: a
       * click on a link, a submitted form, a redirect, a person at the console.
       * Return false to refuse it. Without this only an explicit navigate() was
       * ever checked, so a click on a link to a denied page loaded it before
       * anything could object, and for a page that wipes the database the load
       * is the damage.
       */
      allowNavigation?: (url: string) => boolean;
    },
  ) {}

  private get activePage(): Page {
    if (!this.page) throw new Error("driver not started — call start() first");
    if (this.controlledByHuman) {
      throw new Error("a human holds control of this session; call resume() before automating again");
    }
    return this.page;
  }

  async start(): Promise<SessionHandle> {
    const { chromium } = await import("playwright");
    // Remote debugging is what makes the handoff real: the operator console
    // attaches to this exact browser rather than opening a fresh one.
    //
    // The port is allocated per session, not fixed. A hardcoded 9222 means two
    // sessions can never coexist — fatal for a system meant to pool them — and
    // a browser orphaned by a hard-killed run holds the port indefinitely,
    // silently hanging every subsequent launch.
    const port = this.opts.cdpPort ?? (await freePort());
    this.cdpPort = port;
    this.browser = await chromium.launch({
      headless: this.opts.headless,
      args: [`--remote-debugging-port=${port}`],
    });
    try {
      this.context = await this.browser.newContext();
      this.page = await this.context.newPage();
      const allow = this.opts.allowNavigation;
      if (allow) {
        await this.guardNavigations(this.page, allow);
        // A link that opens a new tab or window is a navigation too.
        this.context.on("page", (p) => void this.guardNavigations(p, allow).catch(() => undefined));
      }
    } catch (error) {
      // The browser is already running and holds the debugging port. Leaving it
      // would orphan a process and block the next launch.
      await this.close();
      throw error;
    }
    logger.info(`[surface] session ${this.sessionId} started (cdp :${port})`);
    return { sessionId: this.sessionId, connectUrl: `http://127.0.0.1:${port}` };
  }

  /**
   * Refuse page loads the policy does not allow, whoever started them.
   *
   * Only *document* requests are paused, through the browser's own request
   * interception. An earlier version routed every request through Playwright,
   * which is simpler but changes the timing of everything: the account table
   * here arrives over AJAX, and with all traffic intercepted the locator looked
   * before it had landed, so half the runs failed. Pausing documents alone
   * leaves scripts, images and XHR untouched.
   */
  private async guardNavigations(page: Page, allow: (url: string) => boolean): Promise<void> {
    const session = await page.context().newCDPSession(page);
    session.on("Fetch.requestPaused", (event: { requestId: string; request: { url: string } }) => {
      const { requestId, request } = event;
      if (allow(request.url)) {
        void session.send("Fetch.continueRequest", { requestId }).catch(() => undefined);
        return;
      }
      logger.warn(`[surface] navigation refused by policy: ${request.url}`);
      void session.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
    });
    await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] });
  }

  async close(): Promise<void> {
    try {
      await this.context?.close();
    } finally {
      // Closing the browser must happen even if closing the context threw.
      try {
        await this.browser?.close();
      } finally {
        this.browser = this.context = this.page = null;
      }
    }
  }

  async navigate(url: string): Promise<void> {
    await this.activePage.goto(new URL(url, this.opts.baseUrl).toString(), {
      waitUntil: "domcontentloaded",
    });
  }

  async observe(opts: { screenshot?: boolean } = {}): Promise<Observation> {
    const page = this.activePage;
    // The ARIA snapshot, not the DOM: it is the representation that ports to a
    // desktop surface, and it is far cheaper in tokens than markup. mode "ai"
    // adds [ref=eN] handles and descends into framesets — both load-bearing
    // here, since legacy back-office apps are full of frames and the refs give
    // the model something concrete to point at before the compiler turns that
    // into a durable locator bundle.
    return {
      url: page.url(),
      title: await page.title(),
      tree: await page.ariaSnapshot({ mode: "ai" }),
      screenshot: opts.screenshot ? await this.screenshot() : undefined,
    };
  }

  async screenshot(): Promise<string> {
    const buf = await this.activePage.screenshot({ type: "png", fullPage: false });
    return buf.toString("base64");
  }

  async visibleText(): Promise<string> {
    return this.activePage.innerText("body");
  }

  /**
   * Pick the frame a locator is scoped to. Legacy back-office apps nest
   * framesets, so the path is a list matched against frame name or URL.
   */
  private targetFrame(framePath: string[]): Frame {
    let frame: Frame = this.activePage.mainFrame();
    for (const segment of framePath) {
      // A frame's name is deliberate; a URL substring is a guess. Prefer the
      // name, so a short segment like "main" cannot pick a sibling whose URL
      // merely contains it.
      const children = frame.childFrames();
      const child = children.find((f) => f.name() === segment) ?? children.find((f) => f.url().includes(segment));
      if (!child) throw new Error(`frame "${segment}" not found under ${frame.url()}`);
      frame = child;
    }
    return frame;
  }

  /**
   * Automation entry points that act on an element handle resolved earlier. The
   * handle outlives a change of owner, so without this a click on a handle taken
   * before the session was ceded would still go through while a person holds it.
   */
  private assertAutomationOwns(): void {
    void this.activePage;
  }

  /**
   * Walk the ranked candidate bundle, most durable first, and take the first
   * that resolves uniquely above the confidence floor.
   *
   * Ambiguity is treated as failure by default, not as "take the first": in a
   * banking grid, acting on the wrong row is worse than not acting. The winning
   * candidate index is reported back so repeated runs expose drift — an
   * artifact that used to resolve on candidate 0 and now needs candidate 2 is
   * still working, but one change away from breaking.
   */
  async resolve(
    locator: Locator,
    interpolate: (s: string) => string,
    opts: { timeoutMs?: number } = {},
  ): Promise<ResolveOutcome> {
    const deadline = Date.now() + (opts.timeoutMs ?? 0);
    let outcome = await this.resolveOnce(locator, interpolate);
    // Playwright's own locators auto-wait; the evaluate-based strategies do
    // not. Polling here keeps every strategy behaving the same way, and is what
    // absorbs the ordinary transient slowness of a server-rendered app.
    while (!outcome.ok && outcome.reason === "not_found" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      outcome = await this.resolveOnce(locator, interpolate);
    }
    return outcome;
  }

  private async resolveOnce(
    locator: Locator,
    interpolate: (s: string) => string,
  ): Promise<ResolveOutcome> {
    const started = Date.now();
    const tried: Array<{ strategy: string; matchCount: number }> = [];
    let frame: Frame;
    try {
      frame = this.targetFrame(locator.region.framePath);
    } catch (error) {
      // A frame that is not there yet (a reload in progress) is "not found", so
      // the caller's polling can wait for it instead of the run dying.
      if (this.controlledByHuman) throw error;
      logger.debug(`[resolve] ${locator.id}: ${(error as Error).message}`);
      return { ok: false, reason: "not_found", tried };
    }

    for (const [index, ranked] of locator.candidates.entries()) {
      if (ranked.confidence < locator.match.minConfidence) continue;

      let matches: ElementHandle[] = [];
      try {
        matches = await this.matchCandidate(frame, ranked.candidate, interpolate);
      } catch (error) {
        logger.debug(`[resolve] ${ranked.candidate.using} threw: ${(error as Error).message}`);
      }
      tried.push({ strategy: ranked.candidate.using, matchCount: matches.length });

      if (matches.length === 0) continue;
      if (matches.length > 1 && locator.match.onMultiple !== "first") {
        logger.warn(`[resolve] ${locator.id}: ${matches.length} matches via ${ranked.candidate.using}`);
        return { ok: false, reason: "ambiguous", tried };
      }

      logger.debug(
        `[resolve] ${locator.id} -> candidate ${index} (${ranked.candidate.using}) in ${Date.now() - started}ms`,
      );
      return {
        ok: true,
        resolution: {
          handle: matches[0]!,
          candidateIndex: index,
          strategy: ranked.candidate.using,
          confidence: ranked.confidence,
          matchCount: matches.length,
          elapsedMs: Date.now() - started,
        },
      };
    }

    logger.debug(
      `[resolve] ${locator.id} NOT FOUND at ${this.page?.url()} — tried ${tried
        .map((t) => `${t.strategy}:${t.matchCount}`)
        .join(", ")}`,
    );
    return { ok: false, reason: "not_found", tried };
  }

  private async matchCandidate(
    frame: Frame,
    candidate: Locator["candidates"][number]["candidate"],
    interpolate: (s: string) => string,
  ): Promise<ElementHandle[]> {
    const fromLocator = (loc: PwLocator) => loc.elementHandles();

    switch (candidate.using) {
      case "role_name":
        return fromLocator(
          frame.getByRole(candidate.role as Parameters<Frame["getByRole"]>[0], {
            name: interpolate(candidate.name),
            exact: candidate.exact,
          }),
        );

      case "field_name": {
        // Names come from the page, so a quote or backslash in one must not
        // break out of the attribute selector.
        const q = (s: string) => s.replace(/[\\"]/g, "\\$&");
        const scope = candidate.formName ? `form[name="${q(candidate.formName)}"] ` : "";
        return fromLocator(frame.locator(`${scope}[name="${q(candidate.name)}"]`));
      }

      case "text":
        return fromLocator(frame.getByText(interpolate(candidate.text), { exact: candidate.exact }));

      case "css":
        return fromLocator(frame.locator(candidate.selector));

      case "xpath":
        return fromLocator(frame.locator(`xpath=${candidate.xpath}`));

      case "ordinal":
        return fromLocator(
          frame.getByRole(candidate.role as Parameters<Frame["getByRole"]>[0]).nth(candidate.index),
        );

      case "label_proximity":
        return this.handlesFrom(frame, matchLabelProximity, {
          labelText: interpolate(candidate.labelText),
          controlSelector: roleSelector(candidate.controlRole),
          direction: candidate.direction,
          maxDistance: candidate.maxDistance,
        });

      case "table_cell":
        return this.handlesFrom(frame, matchTableCell, {
          rowColumnHeader: candidate.rowMatch.columnHeader,
          rowEquals: interpolate(candidate.rowMatch.equals),
          columnHeader: candidate.columnHeader,
          tableIndex: candidate.tableIndex,
        });

      case "near_anchor":
        return this.handlesFrom(frame, matchNearAnchor, {
          anchorText: interpolate(candidate.anchorText),
          targetSelector: roleSelector(candidate.targetRole),
          targetName: candidate.targetName ? interpolate(candidate.targetName) : undefined,
        });
    }
  }

  /** Run a browser-side matcher and lift its result array into element handles. */
  private async handlesFrom<A>(
    frame: Frame,
    matcher: (args: A) => Element[],
    args: A,
  ): Promise<ElementHandle[]> {
    // esbuild (via tsx) wraps named functions in a __name() helper for stack
    // traces. That helper exists in the Node module scope, not in the page, so
    // a serialized matcher dies on ReferenceError. Shimming it is cheaper and
    // more portable than fighting the bundler. Passed as a string so this line
    // is never itself compiled and re-wrapped.
    await frame.evaluate("globalThis.__name = globalThis.__name || function (f) { return f; }");

    // The matcher is serialized into the page; the cast only satisfies
    // Playwright's Unboxed<A> argument typing.
    const arrayHandle = await frame.evaluateHandle(matcher as never, args as never);
    const props = await arrayHandle.getProperties();
    const handles = [...props.values()]
      .map((h) => h.asElement())
      .filter((h): h is ElementHandle => h !== null);
    await arrayHandle.dispose();
    return handles;
  }

  async resolveRef(ref: string): Promise<Resolution | null> {
    const started = Date.now();
    const handles = await this.activePage.locator(`aria-ref=${ref}`).elementHandles();
    if (handles.length !== 1) return null;
    return {
      handle: handles[0]!,
      candidateIndex: 0,
      strategy: "aria_ref",
      confidence: 1,
      matchCount: 1,
      elapsedMs: Date.now() - started,
    };
  }

  async describeTarget(r: Resolution): Promise<HarvestedTarget> {
    await this.activePage.evaluate("globalThis.__name = globalThis.__name || function (f) { return f; }");
    return (r.handle as ElementHandle<Element>).evaluate(describeElement as never) as Promise<HarvestedTarget>;
  }

  async click(r: Resolution): Promise<void> {
    this.assertAutomationOwns();
    await (r.handle as ElementHandle).click();
  }

  async type(r: Resolution, value: string, opts: { clearFirst?: boolean } = {}): Promise<void> {
    this.assertAutomationOwns();
    const handle = r.handle as ElementHandle;
    if (opts.clearFirst === false) {
      await handle.focus();
      await this.activePage.keyboard.type(value);
      return;
    }
    await handle.fill(value);
  }

  async select(r: Resolution, value: string): Promise<void> {
    this.assertAutomationOwns();
    await (r.handle as ElementHandle<HTMLSelectElement>).selectOption(value);
  }

  async press(keys: string): Promise<void> {
    await this.activePage.keyboard.press(keys);
  }

  async read(
    r: Resolution,
    source: "text" | "value" | "attribute",
    attribute?: string,
  ): Promise<string> {
    this.assertAutomationOwns();
    const handle = r.handle as ElementHandle<HTMLElement>;
    switch (source) {
      case "value":
        return handle.inputValue();
      case "attribute":
        if (!attribute) throw new Error("read source 'attribute' requires an attribute name");
        return (await handle.getAttribute(attribute)) ?? "";
      case "text":
        return (await handle.innerText()).trim();
    }
  }

  /**
   * Hand the live session to a person. The browser is untouched — same tab,
   * same cookies, same partially filled form — and every automation call throws
   * until resume() is called. The flag is the "who is in control" marker the
   * brief asks for; the CDP endpoint is how the operator actually connects.
   */
  async cedeControl(): Promise<SessionHandle> {
    this.controlledByHuman = true;
    logger.warn(`[surface] control ceded to human on session ${this.sessionId}`);
    // The port this session actually got, not a guess. Handing an operator a
    // stale 9222 would point them at whatever browser happened to hold it.
    return { sessionId: this.sessionId, connectUrl: `http://127.0.0.1:${this.cdpPort}` };
  }

  async resume(): Promise<void> {
    this.controlledByHuman = false;
    logger.info(`[surface] automation resumed on session ${this.sessionId}`);
  }

  controller(): Controller {
    return this.controlledByHuman ? "human" : "automation";
  }

  /**
   * The operator half of the control model. These deliberately bypass
   * `activePage` — its guard exists to stop *automation* acting while a human
   * holds the session, and these are the human. They refuse in the opposite
   * state, so at no instant can both sides act.
   */
  private get humanPage(): Page {
    if (!this.page) throw new Error("driver not started");
    if (!this.controlledByHuman) {
      throw new Error("automation holds this session; cedeControl() before operating it by hand");
    }
    return this.page;
  }

  async operatorClick(x: number, y: number): Promise<void> {
    await this.humanPage.mouse.click(x, y);
  }

  async operatorType(text: string): Promise<void> {
    await this.humanPage.keyboard.type(text);
  }

  async operatorPress(keys: string): Promise<void> {
    await this.humanPage.keyboard.press(keys);
  }

  async operatorNavigate(url: string): Promise<void> {
    const target = new URL(url, this.opts.baseUrl);
    // new URL() lets an absolute address override the base, so without this an
    // operator (or anything that can reach the console) could point the session
    // at file:// or an internal address. The person acts on the app, not beyond it.
    if (target.origin !== new URL(this.opts.baseUrl).origin) {
      throw new Error(`the operator may only navigate within ${new URL(this.opts.baseUrl).origin}`);
    }
    await this.humanPage.goto(target.toString(), { waitUntil: "domcontentloaded" });
  }

  async operatorScreenshot(): Promise<string> {
    const buf = await this.humanPage.screenshot({ type: "png" });
    return buf.toString("base64");
  }

  operatorUrl(): string {
    return this.page?.url() ?? "";
  }
}

/**
 * Ask the OS for a free ephemeral port.
 *
 * Racy in principle — the port could be taken between close and launch — but
 * the window is microseconds and the alternative, a fixed port, fails
 * deterministically rather than rarely.
 */
async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
