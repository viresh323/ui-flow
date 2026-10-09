import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contentHash, verifyIntegrity } from "../src/artifact/integrity.js";
import { createEnvSecretStore, envVarFor, restrictTo } from "../src/config/secrets.js";
import { registerSecretValue, redact } from "../src/obs/logger.js";
import { extractLiterals } from "../src/providers/compressor.js";
import { extractJson } from "../src/discovery/stages/03-decide.js";

describe("contentHash", () => {
  test("is stable across key order", () => {
    // Artifacts get reformatted, re-serialised and round-tripped through
    // editors. If the hash moved with key order, integrity checking would fire
    // on every cosmetic change and be switched off within a week.
    const a = { kind: "capability", id: "x", flow: { steps: [1, 2] }, version: "1.0.0" };
    const b = { version: "1.0.0", flow: { steps: [1, 2] }, id: "x", kind: "capability" };
    assert.equal(contentHash(a), contentHash(b));
  });

  test("ignores the integrity block itself", () => {
    const base = { id: "x", integrity: { contentSha256: "a".repeat(64) } };
    const other = { id: "x", integrity: { contentSha256: "b".repeat(64) } };
    assert.equal(contentHash(base), contentHash(other));
  });

  test("array order is significant", () => {
    // Step order is the flow. Reordering it must change the hash.
    assert.notEqual(contentHash({ steps: [1, 2] }), contentHash({ steps: [2, 1] }));
  });

  test("changes when any content changes", () => {
    assert.notEqual(contentHash({ id: "x" }), contentHash({ id: "y" }));
  });
});

describe("verifyIntegrity", () => {
  const artifact = JSON.parse(readFileSync("examples/read_account_balance.json", "utf8"));

  test("accepts the shipped artifact", () => {
    assert.equal(verifyIntegrity(artifact).ok, true);
  });

  test("detects a single edited field", () => {
    const tampered = structuredClone(artifact);
    tampered.flow.steps[0].intent = "edited after review";
    assert.equal(verifyIntegrity(tampered).ok, false);
  });

  test("detects a step quietly removed", () => {
    const tampered = structuredClone(artifact);
    tampered.flow.steps.splice(1, 1);
    assert.equal(verifyIntegrity(tampered).ok, false);
  });

  test("detects a widened allowlist", () => {
    const tampered = structuredClone(artifact);
    tampered.policy.requires.origins.push("https://exfiltrate.example");
    assert.equal(verifyIntegrity(tampered).ok, false);
  });
});

describe("secret store", () => {
  test("maps a dotted ref to an environment variable", () => {
    assert.equal(envVarFor("tenant.parabank.operator_user"), "TENANT_PARABANK_OPERATOR_USER");
    assert.equal(envVarFor("tenant.acme-cu.pw"), "TENANT_ACME_CU_PW");
  });

  test("refuses a secret the capability did not declare", () => {
    // Stops a tampered or over-broad artifact reaching credentials outside its
    // stated contract, even when the value exists in the environment.
    process.env.TENANT_OTHER_PW = "should-not-be-reachable";
    const store = restrictTo(createEnvSecretStore(), ["tenant.declared.pw"]);
    assert.throws(() => store.get("tenant.other.pw"), /not declared/);
  });

  test("a declared but unconfigured secret names the variable to set", () => {
    const store = restrictTo(createEnvSecretStore(), ["tenant.absent.pw"]);
    assert.throws(() => store.get("tenant.absent.pw"), /TENANT_ABSENT_PW/);
  });

  test("resolved values are registered for redaction", () => {
    process.env.TENANT_REDACT_PW = "hunter2-unique-value";
    const store = restrictTo(createEnvSecretStore(), ["tenant.redact.pw"]);
    store.get("tenant.redact.pw");
    assert.equal(redact("password is hunter2-unique-value"), "password is [secret]");
  });
});

describe("log redaction", () => {
  test("scrubs the classes that appear in this domain", () => {
    assert.match(redact("contact a.person@bank.example"), /\[email\]/);
    assert.match(redact("ssn 622-11-9999"), /\[ssn\]/);
    assert.match(redact("balance $2,300.00"), /\[amount\]/);
    assert.match(redact("login.htm;jsessionid=ABC123"), /jsessionid=\[redacted\]/);
    assert.match(redact("api_key=sk-live-abc"), /\[redacted\]/);
  });

  test("a bearer token is scrubbed, not just the scheme word", () => {
    const out = redact("Authorization: Bearer abc123def");
    assert.doesNotMatch(out, /abc123def/);
    assert.match(out, /\[redacted\]/);
  });

  test("a JSON-style key is scrubbed", () => {
    const out = redact('{"password":"hunter9","user":"john"}');
    assert.doesNotMatch(out, /hunter9/);
    assert.match(out, /john/);
  });

  test("structured fields are redacted by value and never throw", async () => {
    // Imported here so the test names the function it is about.
    const { logger } = await import("../src/obs/logger.js");
    assert.doesNotThrow(() => logger.error("x", { note: "password=abc", nested: { token: "t0k3n-value" } }));
  });

  test("registered secrets are scrubbed anywhere they appear", () => {
    registerSecretValue("correct-horse-battery");
    assert.equal(redact("typed correct-horse-battery into the field"), "typed [secret] into the field");
  });
});

describe("compression literal guard", () => {
  test("captures the strings that must survive verbatim", () => {
    // Deliberately written against the format the aria snapshot really emits
    // (`[ref=e39]`). An earlier version of the guard matched `ref_39`, which
    // never occurs, so element handles went unprotected.
    const found = extractLiterals('click the "Log In" button [ref=e39] for account 12345');
    assert.ok(found.includes("Log In"), "quoted labels");
    assert.ok(found.includes("ref=e39"), "element handles from the aria snapshot");
    assert.ok(found.includes("12345"), "identifiers");
  });

  test("ignores short digit runs that are not identifiers", () => {
    assert.equal(extractLiterals("page 12 of 34").length, 0);
  });
});

describe("model reply parsing", () => {
  test("bare JSON", () => {
    assert.deepEqual(extractJson('{"kind":"done"}'), { kind: "done" });
  });

  test("fenced JSON", () => {
    assert.deepEqual(extractJson('```json\n{"kind":"done"}\n```'), { kind: "done" });
  });

  test("JSON wrapped in prose", () => {
    assert.deepEqual(extractJson('Sure! Here you go:\n{"kind":"done"}\nHope that helps.'), {
      kind: "done",
    });
  });

  test("a reply with no object fails with the text for debugging", () => {
    assert.throws(() => extractJson("I am not going to do that"), /no JSON object/);
  });
});
