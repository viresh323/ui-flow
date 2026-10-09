import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  applyTransforms,
  coerceOutput,
  interpolate,
  MissingValue,
  resolveValue,
  type ValueScope,
} from "../src/replay/values.js";

const scope = (over: Partial<ValueScope> = {}): ValueScope => ({
  params: { account_id: "12345" },
  bindings: new Map([["balance_text", "-$2300.00"]]),
  secrets: { get: (ref) => (ref === "tenant.p.pw" ? "s3cret" : (() => { throw new Error("undeclared"); })()) },
  ...over,
});

describe("coerceOutput", () => {
  test("reads the shapes ParaBank actually produces", () => {
    assert.equal(coerceOutput("-$2300.00", "money"), -2300);
    assert.equal(coerceOutput("$10.45", "money"), 10.45);
    assert.equal(coerceOutput("$1,234,567.89", "money"), 1234567.89);
  });

  test("refuses shapes it cannot read rather than guessing", () => {
    // Accounting-style negatives are a real back-office format, and we do NOT
    // parse them. Failing loudly is correct; silently returning 2300 for
    // ($2,300.00) would invert the sign of a balance.
    assert.throws(() => coerceOutput("($2,300.00)", "money"), /cannot read/);
    assert.throws(() => coerceOutput("--", "money"), /cannot read/);
    assert.throws(() => coerceOutput("n/a", "money"), /cannot read/);
  });

  test("an empty cell is not zero", () => {
    // Number("") === 0, so a naive implementation reports a balance of $0.00
    // for a cell that rendered blank — indistinguishable from a real zero
    // balance, and wrong in a way the caller cannot detect.
    assert.throws(() => coerceOutput("", "money"), /cannot read/);
    assert.throws(() => coerceOutput("   ", "money"), /cannot read/);
  });

  test("shapes Number() would accept but that are not amounts", () => {
    for (const bad of ["Infinity", "-Infinity", "0x10", "1e3", "1_000"]) {
      assert.throws(() => coerceOutput(bad, "money"), /cannot read/, bad);
      assert.throws(() => coerceOutput(bad, "number"), /cannot read/, bad);
    }
    assert.equal(coerceOutput("-0.5", "number"), -0.5);
    assert.equal(coerceOutput(".5", "number"), 0.5);
  });

  test("an integer must be wholly an integer", () => {
    // parseInt would have returned 12, 3 and 12 for these.
    for (const bad of ["12.9", "3 items", "12abc", "1e3"]) {
      assert.throws(() => coerceOutput(bad, "integer"), /cannot read/, bad);
    }
    assert.equal(coerceOutput("-42", "integer"), -42);
  });

  test("integer and boolean", () => {
    assert.equal(coerceOutput("1,234", "integer"), 1234);
    assert.throws(() => coerceOutput("abc", "integer"), /cannot read/);
    assert.equal(coerceOutput("Yes", "boolean"), true);
    assert.equal(coerceOutput("false", "boolean"), false);
  });

  test("unknown kinds pass through untouched", () => {
    assert.equal(coerceOutput("CHECKING", "string"), "CHECKING");
    assert.equal(coerceOutput("12345", "account_number"), "12345");
  });
});

describe("interpolate", () => {
  test("inherited object names are not parameters", () => {
    // `name in params` is also true for constructor, toString and valueOf.
    assert.equal(interpolate("${constructor}", scope()), "${constructor}");
    assert.equal(interpolate("${toString}", scope()), "${toString}");
  });

  test("substitutes params and bindings", () => {
    assert.equal(interpolate("row ${account_id}", scope()), "row 12345");
    assert.equal(interpolate("${balance_text}", scope()), "-$2300.00");
  });

  test("leaves an unknown name alone rather than emitting 'undefined'", () => {
    // A locator containing the literal text "undefined" would match nothing and
    // produce a confusing failure; leaving the placeholder makes the cause
    // obvious in the resolution report.
    assert.equal(interpolate("${nope}", scope()), "${nope}");
  });

  test("never substitutes secrets", () => {
    // Interpolated values reach locator strings, resolution telemetry and error
    // messages. Secrets must only be resolved where they are consumed.
    assert.equal(interpolate("${tenant.p.pw}", scope()), "${tenant.p.pw}");
  });
});

describe("resolveValue", () => {
  test("each source", () => {
    const s = scope();
    assert.equal(resolveValue({ from: "literal", value: "x" }, s), "x");
    assert.equal(resolveValue({ from: "param", param: "account_id" }, s), "12345");
    assert.equal(resolveValue({ from: "secret", secret: "tenant.p.pw" }, s), "s3cret");
    assert.equal(resolveValue({ from: "binding", binding: "balance_text" }, s), "-$2300.00");
    assert.equal(resolveValue({ from: "template", template: "a/${account_id}" }, s), "a/12345");
  });

  test("a missing required parameter fails with a name the caller can act on", () => {
    assert.throws(
      () => resolveValue({ from: "param", param: "missing" }, scope()),
      (e: Error) => e instanceof MissingValue && /missing/.test(e.message),
    );
  });

  test("a binding read before it is captured fails rather than returning empty", () => {
    assert.throws(() => resolveValue({ from: "binding", binding: "not_yet" }, scope()), MissingValue);
  });
});

describe("applyTransforms", () => {
  test("chains in order", () => {
    assert.equal(applyTransforms("  -$2,300.00  ", [{ op: "trim" }, { op: "strip_currency" }]), "-2300.00");
  });

  test("regex_capture pulls the named group", () => {
    assert.equal(
      applyTransforms("Account 12345 (CHECKING)", [{ op: "regex_capture", pattern: "Account (\\d+)", group: 1 }]),
      "12345",
    );
  });

  test("a regex that does not match yields empty, not the original", () => {
    assert.equal(applyTransforms("nothing here", [{ op: "regex_capture", pattern: "(\\d+)", group: 1 }]), "");
  });

  test("to_number is deferred to the contract boundary", () => {
    // Bindings stay strings so they remain composable; coercion happens once,
    // against the declared output type.
    assert.equal(applyTransforms("10.45", [{ op: "to_number" }]), "10.45");
  });
});
