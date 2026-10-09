import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildLocatorBundle, type HarvestedTarget } from "../src/discovery/harvest.js";

/**
 * The soundness filter is the fix for the worst bug this project had: asking for
 * a nonexistent account returned another customer's balance and reported
 * success, because resolution fell through to a positional CSS path.
 *
 * Its only other evidence is one end-to-end run. For a safety-critical pure
 * function that is not enough, so it gets direct tests over constructed inputs.
 */

const target = (over: Partial<HarvestedTarget> = {}): HarvestedTarget => ({
  tagName: "td",
  role: "cell",
  accessibleName: null,
  labelText: null,
  fieldName: null,
  formName: null,
  tablePosition: null,
  cssPath: "table > tbody > tr:nth-of-type(1) > td:nth-of-type(2)",
  ownText: "-$2300.00",
  ...over,
});

/** Stands in for the compiler's parameteriser: 12345 was the discovery value. */
const parameterise = (s: string) => s.split("12345").join("${account_id}");
const usings = (l: ReturnType<typeof buildLocatorBundle>) => l.candidates.map((c) => c.candidate.using);

describe("buildLocatorBundle — soundness filter", () => {
  test("drops candidates that cannot express the parameter", () => {
    const bundle = buildLocatorBundle(
      "read_balance",
      target({
        tablePosition: { columnHeader: "Balance", rowKeyHeader: "Account", rowKeyValue: "12345" },
        labelText: "12345",
      }),
      parameterise,
    );

    assert.ok(usings(bundle).includes("table_cell"), "the parameterised strategy survives");
    assert.equal(
      usings(bundle).includes("css"),
      false,
      "a positional CSS path cannot discriminate rows and must be dropped",
    );
    for (const c of bundle.candidates) {
      assert.match(
        JSON.stringify(c.candidate),
        /\$\{account_id\}/,
        `every surviving candidate must carry the parameter: ${c.candidate.using}`,
      );
    }
  });

  test("the exact bug: a row-specific target never keeps a positional fallback", () => {
    const bundle = buildLocatorBundle(
      "read_balance",
      target({
        tablePosition: { columnHeader: "Balance", rowKeyHeader: "Account", rowKeyValue: "12345" },
      }),
      parameterise,
    );
    // Before the fix this bundle ended in the CSS path, which on a missing
    // account resolved to row 1 and returned the wrong customer's money.
    assert.equal(usings(bundle).at(-1), "table_cell");
  });

  test("keeps every candidate when nothing is parameterised", () => {
    const bundle = buildLocatorBundle(
      "login_button",
      target({ tagName: "input", role: "button", accessibleName: "Log In", cssPath: "form > input" }),
      parameterise,
    );
    assert.deepEqual(usings(bundle), ["role_name", "css"]);
  });

  test("a target with no parameterisable identity still gets a usable fallback", () => {
    const bundle = buildLocatorBundle("odd", target({ role: null, accessibleName: null }), parameterise);
    assert.deepEqual(usings(bundle), ["css"], "dropping everything would leave nothing to resolve");
  });
});

describe("buildLocatorBundle — ranking", () => {
  test("role+name outranks every other strategy", () => {
    const bundle = buildLocatorBundle(
      "btn",
      target({ role: "button", accessibleName: "Log In", fieldName: "submit" }),
      parameterise,
    );
    assert.equal(usings(bundle)[0], "role_name");
  });

  test("label proximity is offered only when there is no accessible name", () => {
    const withName = buildLocatorBundle(
      "a",
      target({ role: "textbox", accessibleName: "Username", labelText: "Username" }),
      parameterise,
    );
    const withoutName = buildLocatorBundle(
      "b",
      target({ role: "textbox", accessibleName: null, labelText: "Username" }),
      parameterise,
    );
    assert.equal(usings(withName).includes("label_proximity"), false);
    assert.ok(usings(withoutName).includes("label_proximity"), "the ParaBank login case");
  });

  test("css is always ranked last when present", () => {
    const bundle = buildLocatorBundle(
      "x",
      target({ role: "textbox", labelText: "Username", fieldName: "username", formName: "login" }),
      parameterise,
    );
    assert.equal(usings(bundle).at(-1), "css");
  });

  test("every candidate carries a confidence in range", () => {
    const bundle = buildLocatorBundle("x", target({ role: "button", accessibleName: "Go" }), parameterise);
    for (const c of bundle.candidates) {
      assert.ok(c.confidence > 0 && c.confidence <= 1, `confidence out of range for ${c.candidate.using}`);
    }
  });
});
