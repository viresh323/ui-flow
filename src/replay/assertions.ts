import type { Assertion, Locator } from "../artifact/index.js";
import type { SurfaceDriver } from "../surface/driver.js";
import { interpolate, resolveValue, type ValueScope } from "./values.js";

/**
 * Assertion evaluation.
 *
 * Assertions do triple duty: preconditions guard a step, postconditions verify
 * it actually happened, and detectors recognise business outcomes and
 * recoverable conditions. One evaluator for all three keeps the artifact's
 * vocabulary small and means a reviewer reads the same shape everywhere.
 */

export interface AssertionContext {
  driver: SurfaceDriver;
  scope: ValueScope;
}

export async function evaluate(assertion: Assertion, ctx: AssertionContext): Promise<boolean> {
  const { driver, scope } = ctx;
  const resolveIn = (s: string) => interpolate(s, scope);

  switch (assertion.assert) {
    case "element_present": {
      const outcome = await driver.resolve(assertion.locator, resolveIn);
      // Found more than once is still found. Reading it as "not present" would
      // make a negated check such as ACCOUNT_NOT_FOUND (not(element_present))
      // fire on a page where the account is there but listed twice. Acting on
      // an ambiguous element still fails closed at the step itself.
      return outcome.ok || outcome.reason === "ambiguous";
    }

    case "element_absent": {
      const outcome = await driver.resolve(assertion.locator, resolveIn);
      // Absent means the locator found nothing. An *ambiguous* result found the
      // element several times, so it is very much present; counting it as absent
      // would let a "no results" check pass on a page that has results.
      return !outcome.ok && outcome.reason === "not_found";
    }

    case "text_matches": {
      const haystack = assertion.locator
        ? await readLocatorText(assertion.locator, ctx)
        : await driver.visibleText();
      if (haystack === null) return false;
      return new RegExp(assertion.pattern, assertion.flags).test(haystack);
    }

    case "url_matches": {
      const { url } = await driver.observe();
      return new RegExp(assertion.pattern).test(url);
    }

    case "value_equals": {
      const actual = await readLocatorText(assertion.locator, ctx);
      if (actual === null) return false;
      return actual.trim() === resolveValue(assertion.expected, scope).trim();
    }

    case "all": {
      for (const sub of assertion.of) if (!(await evaluate(sub, ctx))) return false;
      return true;
    }

    case "any": {
      for (const sub of assertion.of) if (await evaluate(sub, ctx)) return true;
      return false;
    }

    case "not":
      return !(await evaluate(assertion.of, ctx));
  }
}

async function readLocatorText(
  locator: Locator,
  ctx: AssertionContext,
): Promise<string | null> {
  const outcome = await ctx.driver.resolve(locator, (s) => interpolate(s, ctx.scope));
  if (!outcome.ok) return null;
  return ctx.driver.read(outcome.resolution, "text");
}

/** One-line rendering for failure reports — `expected` in the result contract. */
export function describe(assertion: Assertion): string {
  switch (assertion.assert) {
    case "element_present":
      return `element present: ${assertion.locator.describe}`;
    case "element_absent":
      return `element absent: ${assertion.locator.describe}`;
    case "text_matches":
      return `text matches /${assertion.pattern}/${assertion.flags}`;
    case "url_matches":
      return `url matches /${assertion.pattern}/`;
    case "value_equals":
      return `value of ${assertion.locator.describe} equals expected`;
    case "all":
      return `all of [${assertion.of.map(describe).join("; ")}]`;
    case "any":
      return `any of [${assertion.of.map(describe).join("; ")}]`;
    case "not":
      return `not (${describe(assertion.of)})`;
  }
}
