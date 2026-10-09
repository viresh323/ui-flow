import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config/config.js";
import { PlaywrightDriver } from "../src/surface/playwrightDriver.js";
import { replay } from "../src/replay/engine.js";
import { OperatorConsole } from "../src/escalation/console.js";
import { Capability } from "../src/artifact/index.js";

/**
 * The irreversible step, handed to a human (§3.4 + §3.6 together).
 *
 * This is the case the operator console exists for, and it was broken in a way
 * `handoff-check` could not see: the policy gate was evaluated *outside* the
 * try block, so the escalation it raised bypassed the suspend logic entirely
 * and terminated the run. The locator-unresolved path that handoff-check
 * exercises is thrown from inside the try, so it worked throughout.
 *
 * Two distinct assertions, because they fail independently:
 *   - the run SUSPENDS on an irreversible step rather than ending;
 *   - an operator who resumes has thereby *authorised* it, so the retry
 *     proceeds instead of re-failing the same gate.
 */

const PORT = 8792;
const cfg = loadConfig();
const capability = Capability.parse(
  JSON.parse(readFileSync("examples/discovered-write/open_savings_account.json", "utf8")),
);

const driver = new PlaywrightDriver({ headless: true, baseUrl: cfg.tenant.baseUrl });
const operator = new OperatorConsole({ port: PORT, evidenceDir: "runs/confirm" });
const base = `http://127.0.0.1:${PORT}`;
const checks: string[] = [];
const check = (ok: boolean, label: string) => checks.push(`${ok ? "PASS" : "FAIL"}  ${label}`);

await operator.start();
await driver.start();

async function playApprover(): Promise<void> {
  const deadline = Date.now() + cfg.stepTimeoutMs + 30_000;
  let id: string | undefined;
  while (!id && Date.now() < deadline) {
    id = operator.list().find((x) => x.state === "pending")?.interventionId;
    if (!id) await new Promise((r) => setTimeout(r, 200));
  }
  if (!id) throw new Error("the run never asked for authorisation");

  const iv = operator.list().find((x) => x.interventionId === id)!;
  check(true, `intervention raised (${id})`);
  check(iv.reason === "irreversible_step", `raised for the right reason (${iv.reason})`);
  check(iv.atStepId === "click_6", `stopped at the submit step (${iv.atStepId})`);
  check(driver.controller() === "human", "control handed to the operator");

  // The reviewer records why, then authorises by resuming.
  await fetch(`${base}/i/${id}/act`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      operator: "risk.reviewer",
      kind: "note",
      value: "reviewed: opening a SAVINGS account for this member is expected",
    }),
    redirect: "manual",
  });
  await fetch(`${base}/i/${id}/finish`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ decision: "resume" }),
    redirect: "manual",
  });
}

try {
  const [result] = await Promise.all([
    replay({
      capability,
      params: { funding_account_id: "12345" },
      cfg,
      driver,
      evidenceDir: "runs/confirm",
      // Deliberately NOT humanConfirmed: the console is the confirmation.
      onEscalation: (req, d) => operator.raise(req, d),
    }),
    playApprover(),
  ]);

  check(result.status === "success", `run completed after authorisation (${result.status})`);
  check(
    result.humanActions.some((a) => a.kind === "note"),
    "the reviewer's note is on the result",
  );
  if (result.status === "success") {
    const account = String(Object.values(result.outputs)[0] ?? "");
    check(/^\d+$/.test(account), `a real account was opened (${account || "empty"})`);
  }

  console.log(checks.join("\n"));
  console.log(checks.every((c) => c.startsWith("PASS")) ? "\nALL PASS" : "\nSOME FAILED");
  if (!checks.every((c) => c.startsWith("PASS"))) process.exitCode = 1;
} finally {
  await operator.stop();
  await driver.close();
}
