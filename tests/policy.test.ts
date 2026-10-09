import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { authorizeCapability, authorizeStep, authorizeUrl } from "../src/config/policy.js";
import { Capability } from "../src/artifact/index.js";
import type { TenantConfig } from "../src/config/config.js";

const tenant: TenantConfig = {
  tenantId: "acme-cu",
  baseUrl: "http://localhost:8080",
  product: "parabank",
  allow: {
    origins: ["http://localhost:8080"],
    pathPrefixes: ["/parabank/"],
    actions: ["navigate", "click", "type", "select", "press", "read"],
  },
  deny: { pathPrefixes: ["/parabank/initializeDB.htm", "/parabank/admin.htm"] },
};

const cap = Capability.parse(JSON.parse(readFileSync("examples/read_account_balance.json", "utf8")));
const withPolicy = (over: Partial<typeof cap.policy>) =>
  ({ ...cap, policy: { ...cap.policy, ...over } }) as typeof cap;

describe("authorizeUrl", () => {
  test("permits an allowed path", () => {
    assert.equal(authorizeUrl("/parabank/overview.htm", tenant).allowed, true);
  });

  test("denies beat allows", () => {
    // initializeDB.htm wipes the database and sits UNDER an allowed prefix.
    // "Allowed by prefix" is not sufficient on its own.
    const d = authorizeUrl("/parabank/initializeDB.htm", tenant);
    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.code, "PATH_DENIED");
  });

  test("a foreign origin is refused even on an allowed path", () => {
    const d = authorizeUrl("https://evil.example/parabank/overview.htm", tenant);
    assert.equal(d.allowed === false && d.code, "ORIGIN_BLOCKED");
  });

  test("an unlisted path on an allowed origin is refused", () => {
    const d = authorizeUrl("/other-app/index.htm", tenant);
    assert.equal(d.allowed === false && d.code, "PATH_NOT_ALLOWED");
  });

  test("a path that merely starts with a denied string is still denied", () => {
    assert.equal(authorizeUrl("/parabank/admin.htm?x=1", tenant).allowed, false);
  });

  test("garbage is refused rather than throwing", () => {
    assert.equal(authorizeUrl("http://[::bad", tenant).allowed, false);
  });

  // The URL parser leaves these spellings alone, and a servlet container undoes
  // every one of them, so each reaches the page the deny list exists to block.
  for (const spelling of [
    "/parabank//initializeDB.htm", // doubled slash
    "/parabank/%69nitializeDB.htm", // percent-encoded letter
    "/parabank/%2569nitializeDB.htm", // double-encoded
    "/parabank/x/..;/admin.htm", // path parameter hiding a dot segment
    "/parabank/INITIALIZEDB.htm", // case
    "/parabank/initializeDB.htm;jsessionid=AB12", // path parameter on the denied page
  ]) {
    test(`a denied page cannot be reached as ${spelling}`, () => {
      const d = authorizeUrl(spelling, tenant);
      assert.equal(d.allowed, false);
    });
  }

  test("a session id in an allowed path does not make it look like a different page", () => {
    assert.equal(authorizeUrl("/parabank/overview.htm;jsessionid=AB12", tenant).allowed, true);
  });

  test("a malformed escape is refused", () => {
    const d = authorizeUrl("/parabank/%E0%A4%A", tenant);
    assert.equal(d.allowed, false);
  });
});

describe("authorizeCapability", () => {
  test("accepts a capability matching the tenant product", () => {
    assert.equal(authorizeCapability(cap, tenant).allowed, true);
  });

  test("refuses a capability recorded against a different product", () => {
    const d = authorizeCapability(cap, { ...tenant, product: "symitar" });
    assert.equal(d.allowed === false && d.code, "PRODUCT_MISMATCH");
  });

  test("a capability cannot widen the tenant grant", () => {
    // The whole point of intersecting rather than unioning: an artifact asking
    // for an action the tenant never granted is refused at load.
    // The cast is the point: TypeScript will not let this be *written*, but a
    // tampered or hand-edited artifact arrives as JSON and bypasses every
    // compile-time guarantee. That is exactly why the check exists at runtime.
    const greedy = withPolicy({
      requires: {
        ...cap.policy.requires,
        actions: ["navigate", "click", "type", "read", "delete"] as never,
      },
    });
    const d = authorizeCapability(greedy, tenant);
    assert.equal(d.allowed === false && d.code, "ACTION_NOT_GRANTED");
    assert.match(d.allowed === false ? d.reason : "", /delete/);
  });

  test("refuses when no declared origin is granted", () => {
    const elsewhere = withPolicy({
      requires: { ...cap.policy.requires, origins: ["https://other.example"] },
    });
    assert.equal(authorizeCapability(elsewhere, tenant).allowed, false);
  });

  test("a capability recorded against several deployments loads where one is granted", () => {
    // The hand-written example lists the public demo and a local origin. The
    // origin the tenant never granted still cannot be visited: authorizeUrl
    // checks every navigation against the tenant allowlist.
    const mixed = withPolicy({
      requires: { ...cap.policy.requires, origins: [tenant.allow.origins[0]!, "https://other.example"] },
    });
    assert.equal(authorizeCapability(mixed, tenant).allowed, true);
    assert.equal(
      authorizeUrl("https://other.example/parabank/overview.htm", tenant).allowed === false,
      true,
    );
  });

  test("a trailing slash does not make a granted origin look ungranted", () => {
    const slashed = withPolicy({
      requires: { ...cap.policy.requires, origins: [`${tenant.allow.origins[0]}/`] },
    });
    assert.equal(authorizeCapability(slashed, tenant).allowed, true);
  });
});

describe("authorizeStep", () => {
  test("safe and reversible steps pass unconditionally", () => {
    assert.equal(authorizeStep("safe", cap, { humanConfirmed: false }).allowed, true);
    assert.equal(authorizeStep("reversible", cap, { humanConfirmed: false }).allowed, true);
  });

  test("an irreversible step needs a human by default", () => {
    const d = authorizeStep("irreversible", cap, { humanConfirmed: false });
    assert.equal(d.allowed === false && d.code, "NEEDS_HUMAN_CONFIRMATION");
  });

  test("and proceeds once a human has confirmed", () => {
    assert.equal(authorizeStep("irreversible", cap, { humanConfirmed: true }).allowed, true);
  });

  test("policy 'block' refuses even with confirmation", () => {
    const blocked = withPolicy({ irreversibleStepPolicy: "block" });
    assert.equal(authorizeStep("irreversible", blocked, { humanConfirmed: true }).allowed, false);
  });

  test("policy 'allow_with_audit' proceeds without a human", () => {
    const audited = withPolicy({ irreversibleStepPolicy: "allow_with_audit" });
    assert.equal(authorizeStep("irreversible", audited, { humanConfirmed: false }).allowed, true);
  });
});
