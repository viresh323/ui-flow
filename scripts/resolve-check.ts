import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config/config.js";
import { PlaywrightDriver } from "../src/surface/playwrightDriver.js";
import { Capability, Locator } from "../src/artifact/index.js";

/**
 * Resolve the real artifact's locators against the live app. This is the check
 * that the ranked-bundle design actually pays off: the username field has no
 * accessible name, so candidate 0 (role+name) must fail and a later candidate
 * must carry it.
 */
const cfg = loadConfig();
const cap = Capability.parse(JSON.parse(readFileSync("examples/read_account_balance.json", "utf8")));
const driver = new PlaywrightDriver({ headless: true, baseUrl: cfg.tenant.baseUrl });
const id = (s: string) => s;

function locatorsOf(c: typeof cap): Array<{ label: string; locator: Locator }> {
  const out: Array<{ label: string; locator: Locator }> = [];
  for (const step of c.flow.steps) {
    const a = step.action as { target?: Locator };
    if (a.target) out.push({ label: step.id, locator: a.target });
  }
  return out;
}

await driver.start();
await driver.navigate(cap.app.entryPoint.path);

for (const { label, locator } of locatorsOf(cap)) {
  const outcome = await driver.resolve(locator, id);
  if (outcome.ok) {
    const { candidateIndex, strategy, matchCount, elapsedMs } = outcome.resolution;
    const skipped = locator.candidates
      .slice(0, candidateIndex)
      .map((c) => c.candidate.using)
      .join(" -> ");
    console.log(
      `${label.padEnd(16)} OK   candidate ${candidateIndex} (${strategy}) matches=${matchCount} ${elapsedMs}ms` +
        (skipped ? `   [failed first: ${skipped}]` : ""),
    );
  } else {
    console.log(
      `${label.padEnd(16)} FAIL ${outcome.reason}  tried=${outcome.tried.map((t) => `${t.strategy}:${t.matchCount}`).join(", ")}`,
    );
  }
}

// A locator that should find nothing, to prove failure is detected rather than
// silently resolving to something adjacent.
const bogus = Locator.parse({
  id: "bogus",
  describe: "a control that does not exist",
  candidates: [
    { candidate: { using: "label_proximity", labelText: "Sort Code", controlRole: "textbox" }, confidence: 0.9 },
    { candidate: { using: "field_name", name: "sortcode" }, confidence: 0.8 },
  ],
});
const miss = await driver.resolve(bogus, id);
console.log(`${"bogus".padEnd(16)} ${miss.ok ? "OK (UNEXPECTED)" : `FAIL ${miss.reason} (expected)`}`);

// An ambiguous locator: many links on the page, no disambiguation.
const ambiguous = Locator.parse({
  id: "ambiguous",
  describe: "any link at all",
  candidates: [{ candidate: { using: "css", selector: "a" }, confidence: 0.9 }],
});
const amb = await driver.resolve(ambiguous, id);
console.log(`${"ambiguous".padEnd(16)} ${amb.ok ? "OK (UNEXPECTED)" : `FAIL ${amb.reason} (expected)`}`);

await driver.close();
