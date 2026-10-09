import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/config/config.js";
import { PlaywrightDriver } from "../src/surface/playwrightDriver.js";
import { replay } from "../src/replay/engine.js";
import { Capability } from "../src/artifact/index.js";

/**
 * Exercises every branch of the replay result contract (§3.3) against the live
 * app: success, both declared business outcomes, and the hard failures. This is
 * the test that the three-way taxonomy is real rather than asserted.
 */

const cfg = loadConfig();
const source = readFileSync("examples/read_account_balance.json", "utf8");
const capability = Capability.parse(JSON.parse(source));

interface Case {
  name: string;
  expect: string;
  params?: Record<string, unknown>;
  mutate?: () => void;
  restore?: () => void;
}

const goodPassword = process.env.TENANT_PARABANK_OPERATOR_PASSWORD;

const cases: Case[] = [
  { name: "happy path", expect: "success", params: { account_id: "12345" } },
  {
    name: "unknown account",
    expect: "business_outcome/ACCOUNT_NOT_FOUND",
    params: { account_id: "99999" },
  },
  {
    name: "bad credentials",
    expect: "business_outcome/LOGIN_FAILED",
    params: { account_id: "12345" },
    mutate: () => (process.env.TENANT_PARABANK_OPERATOR_PASSWORD = "wrong-password"),
    restore: () => (process.env.TENANT_PARABANK_OPERATOR_PASSWORD = goodPassword),
  },
  { name: "missing parameter", expect: "failed/MISSING_INPUT", params: {} },
  {
    name: "tampered artifact",
    expect: "failed/INTEGRITY_MISMATCH",
    params: { account_id: "12345" },
    mutate: () => {
      capability.flow.steps[0]!.intent = "tampered after review";
    },
    restore: () => {
      capability.flow.steps[0]!.intent = Capability.parse(JSON.parse(source)).flow.steps[0]!.intent;
    },
  },
];

const results: string[] = [];

for (const c of cases) {
  c.mutate?.();
  const driver = new PlaywrightDriver({ headless: true, baseUrl: cfg.tenant.baseUrl });
  try {
    await driver.start();
    const r = await replay({ capability, params: c.params ?? {}, cfg, driver });
    const detail =
      r.status === "business_outcome"
        ? `${r.status}/${r.outcome}`
        : r.status === "failed"
          ? `${r.status}/${r.error.code}`
          : r.status === "escalated"
            ? `${r.status}/${r.reason}`
            : r.status;
    const outputs = r.status === "success" ? ` ${JSON.stringify(r.outputs)}` : "";
    const pass = detail === c.expect ? "PASS" : "FAIL";
    results.push(`${pass}  ${c.name.padEnd(20)} ${detail}${outputs}`);
  } catch (error) {
    results.push(`FAIL  ${c.name.padEnd(20)} threw: ${(error as Error).message}`);
  } finally {
    await driver.close();
    c.restore?.();
  }
}

writeFileSync("runs/taxonomy.txt", results.join("\n"));
console.log(results.join("\n"));
const allPassed = results.every((r) => r.startsWith("PASS"));
console.log(allPassed ? "\nALL PASS" : "\nSOME FAILED");
// A check that prints FAIL but exits 0 reads as a pass to anything that runs it.
if (!allPassed) process.exitCode = 1;
