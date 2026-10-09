import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config/config.js";
import { PlaywrightDriver } from "../src/surface/playwrightDriver.js";
import { replay } from "../src/replay/engine.js";
import { OperatorConsole } from "../src/escalation/console.js";
import { Capability, Locator } from "../src/artifact/index.js";
import { contentHash } from "../src/artifact/integrity.js";

/**
 * End-to-end proof of the control-transfer model (§3.6).
 *
 * Scenario, and it is the realistic one: the automation is given the wrong
 * operator password, so login fails and the step that reads the balance cannot
 * resolve. A human is called in, logs in by hand *on the same live session*,
 * and hands control back. The automation resumes from the step that stopped and
 * completes.
 *
 * The operator is played over the console's own HTTP API — the same requests
 * its forms make — and acts by clicking coordinates on the screenshot, exactly
 * as a person would. What this asserts is the part that is easy to fake:
 *
 *  - the run suspends rather than failing;
 *  - automation is locked out while the human holds the session;
 *  - the human's work persists into the resumed run (same tab, same cookies);
 *  - control returns and the run completes with real outputs;
 *  - what the human did is recorded on the result.
 */

const PORT = 8791;
const cfg = loadConfig();
const capability = Capability.parse(
  JSON.parse(readFileSync(process.argv[2] ?? "examples/read_account_balance.json", "utf8")),
);

// The reviewed capability declares LOGIN_FAILED and ACCOUNT_NOT_FOUND, and a
// declared outcome outranks escalation: a rotated password there is answered
// cleanly and never reaches a person. That is right for production, and is why
// this check stopped exercising a handoff. A handoff is for what nobody
// anticipated, so run it as a freshly discovered draft is, with no declared
// outcomes (and recompute the hash, or the integrity gate refuses the copy).
capability.contract.outcomes = [];
capability.integrity.contentSha256 = contentHash(capability as unknown as Record<string, unknown>);

const driver = new PlaywrightDriver({ headless: true, baseUrl: cfg.tenant.baseUrl });
const operator = new OperatorConsole({ port: PORT, evidenceDir: "runs/handoff" });
const base = `http://127.0.0.1:${PORT}`;
const checks: string[] = [];
const check = (ok: boolean, label: string) => checks.push(`${ok ? "PASS" : "FAIL"}  ${label}`);

const realUser = process.env.TENANT_PARABANK_OPERATOR_USER ?? "john";
const realPassword = process.env.TENANT_PARABANK_OPERATOR_PASSWORD ?? "demo";

const L = (id: string, o: Record<string, unknown>) =>
  Locator.parse({ id, describe: id, candidates: [{ candidate: o, confidence: 0.9 }] });

await operator.start();
await driver.start();

/**
 * Where the login controls sit on screen. Captured while automation still holds
 * the session, because during the handoff it is locked out — and an operator
 * works from what they can see anyway.
 */
await driver.navigate(capability.app.entryPoint.path);
const boxOf = async (locator: ReturnType<typeof L>) => {
  const r = await driver.resolve(locator, (s) => s, { timeoutMs: 5000 });
  if (!r.ok) throw new Error(`could not locate ${locator.id} to plan the operator's clicks`);
  const box = await (r.resolution.handle as { boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> }).boundingBox();
  if (!box) throw new Error(`${locator.id} has no box`);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
};
const userXY = await boxOf(L("username", { using: "label_proximity", labelText: "Username", controlRole: "textbox" }));
const passXY = await boxOf(L("password", { using: "label_proximity", labelText: "Password", controlRole: "textbox" }));
const loginXY = await boxOf(L("login", { using: "role_name", role: "button", name: "Log In", exact: true }));

async function playHuman(): Promise<void> {
  // The stuck step exhausts its own resolution budget before escalating, so the
  // wait has to comfortably outlast that.
  // A refused login is also answered by the SESSION_EXPIRED recovery, which
  // re-enters and retries the read: the step times out twice before it
  // escalates, so allow three timeouts, not one.
  const deadline = Date.now() + cfg.stepTimeoutMs * 3 + 30_000;
  let id: string | undefined;
  while (!id && Date.now() < deadline) {
    id = operator.list().find((x) => x.state === "pending")?.interventionId;
    if (!id) await new Promise((r) => setTimeout(r, 250));
  }
  if (!id) throw new Error("no intervention was ever raised");
  check(true, `intervention raised (${id})`);

  check(driver.controller() === "human", "controller flipped to human");
  let lockedOut = false;
  try {
    await driver.observe();
  } catch {
    lockedOut = true;
  }
  check(lockedOut, "automation is locked out during the handoff");

  const page = await (await fetch(`${base}/i/${id}`)).text();
  check(page.includes(capability.id), "console shows which capability stopped");
  check(page.includes("Live session"), "console shows the live session");

  const act = (body: Record<string, string>) =>
    fetch(`${base}/i/${id}/act`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ operator: "test.operator", ...body }),
      redirect: "manual",
    });

  // The human logs in by hand, on the session the automation was using.
  await act({ kind: "navigate", value: capability.app.entryPoint.path });
  await act({ kind: "click", x: String(userXY.x), y: String(userXY.y) });
  await act({ kind: "type", value: realUser });
  await act({ kind: "click", x: String(passXY.x), y: String(passXY.y) });
  await act({ kind: "type", value: realPassword, sensitive: "on" });
  await act({ kind: "click", x: String(loginXY.x), y: String(loginXY.y) });
  await act({ kind: "note", value: "signed in manually after the automation was refused" });

  const claimed = operator.list().find((x) => x.interventionId === id)!;
  check(claimed.state === "claimed", "intervention shows as claimed by an operator");
  check(claimed.humanActions.length === 7, `operator actions recorded (${claimed.humanActions.length})`);
  const typed = claimed.humanActions.filter((a) => a.kind === "type");
  check(
    typed.some((a) => a.value === "[redacted by operator]"),
    "password the operator typed was not stored",
  );

  await fetch(`${base}/i/${id}/finish`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ decision: "resume" }),
    redirect: "manual",
  });
}

try {
  // Give the automation credentials that will be refused. This is what forces
  // the handoff, and it is a real production failure mode: a rotated password,
  // a locked service account.
  process.env.TENANT_PARABANK_OPERATOR_PASSWORD = "deliberately-wrong";

  const [result] = await Promise.all([
    replay({
      capability,
      params: { account_id: "12345" },
      cfg,
      driver,
      evidenceDir: "runs/handoff",
      onEscalation: (req, d) => operator.raise(req, d),
    }),
    playHuman(),
  ]);

  check(driver.controller() === "automation", "control returned to automation");
  check(result.humanActions.length === 7, "human actions surfaced on the result");
  check(result.status === "success", `run resumed and completed (status: ${result.status})`);
  if (result.status === "success") {
    check(
      result.outputs[Object.keys(result.outputs)[0]!] !== undefined,
      `output produced after the handoff: ${JSON.stringify(result.outputs)}`,
    );
  }

  console.log(checks.join("\n"));
  const allPassed = checks.every((c) => c.startsWith("PASS"));
  console.log(allPassed ? "\nALL PASS" : "\nSOME FAILED");
  if (!allPassed) process.exitCode = 1;
} finally {
  process.env.TENANT_PARABANK_OPERATOR_PASSWORD = realPassword;
  await operator.stop();
  await driver.close();
}
