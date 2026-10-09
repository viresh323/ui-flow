import type { Transform, ValueExpr } from "../artifact/index.js";
import type { SecretStore } from "../config/secrets.js";

/**
 * Turning declared values into concrete ones at replay time.
 *
 * Three sources, resolved in the same place so the rules stay uniform:
 * caller-supplied parameters, secrets fetched at the moment of use, and
 * bindings captured earlier in this run.
 */

export interface ValueScope {
  params: Record<string, unknown>;
  bindings: Map<string, string>;
  secrets: SecretStore;
}

export class MissingValue extends Error {
  constructor(what: string) {
    super(what);
    this.name = "MissingValue";
  }
}

export function resolveValue(expr: ValueExpr, scope: ValueScope): string {
  switch (expr.from) {
    case "literal":
      return String(expr.value ?? "");
    case "param": {
      const v = scope.params[expr.param];
      if (v === undefined) throw new MissingValue(`required parameter "${expr.param}" was not supplied`);
      return String(v);
    }
    case "secret":
      return scope.secrets.get(expr.secret);
    case "binding": {
      const v = scope.bindings.get(expr.binding);
      if (v === undefined) throw new MissingValue(`binding "${expr.binding}" has not been captured yet`);
      return v;
    }
    case "template":
      return interpolate(expr.template, scope);
  }
}

/**
 * `${name}` substitution over params and bindings — never secrets. A secret
 * interpolated into a locator string would end up in resolution telemetry and
 * error messages; if you need one, use `{from: "secret"}` where the value is
 * actually consumed.
 */
export function interpolate(text: string, scope: ValueScope): string {
  return text.replace(/\$\{([a-z][a-z0-9_]*)\}/gi, (whole, name: string) => {
    // Own keys only: `in` also matches inherited names, so ${constructor} or
    // ${toString} would interpolate a function's source text.
    if (Object.hasOwn(scope.params, name)) return String(scope.params[name]);
    const bound = scope.bindings.get(name);
    if (bound !== undefined) return bound;
    return whole;
  });
}

/** Post-processing declared on a `read` step or an output field. */
export function applyTransforms(value: string, transforms: Transform[]): string {
  let out = value;
  for (const t of transforms) {
    switch (t.op) {
      case "trim":
        out = out.trim();
        break;
      case "strip_currency":
        out = out.replace(/[$£€,\s]/g, "");
        break;
      case "regex_capture": {
        const m = new RegExp(t.pattern).exec(out);
        out = m?.[t.group] ?? "";
        break;
      }
      case "to_number":
      case "to_date":
        // Coercion happens at the contract boundary (coerceOutput), not here,
        // so intermediate bindings stay strings and stay composable.
        break;
    }
  }
  return out;
}

/**
 * Coerce a captured string to the type the contract declares. A `money` output
 * that silently returns "1,234.56" as a string is a bug waiting to happen in
 * the caller — the contract says number, so it must be a number or fail.
 */
export function coerceOutput(value: string, kind: string): unknown {
  switch (kind) {
    case "number":
    case "money": {
      const stripped = value.replace(/[$£€,\s]/g, "");
      // Number("") is 0, so an empty cell would be reported as a real $0.00
      // balance — wrong in a way the caller cannot detect. A cell that rendered
      // blank is a failure to read, not a zero.
      if (stripped === "") throw new Error(`cannot read "${value}" as ${kind}: empty`);
      // Number() would also accept "Infinity", "0x10" and "1e3". A cell holding
      // any of those is not an amount, and returning one as a balance would be a
      // wrong answer the caller cannot detect.
      if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(stripped)) throw new Error(`cannot read "${value}" as ${kind}`);
      const n = Number(stripped);
      if (!Number.isFinite(n)) throw new Error(`cannot read "${value}" as ${kind}`);
      return n;
    }
    case "integer": {
      const stripped = value.replace(/[,\s]/g, "");
      if (stripped === "") throw new Error(`cannot read "${value}" as integer: empty`);
      // parseInt would turn "12.9" into 12 and "3 items" into 3. A cell that is
      // not wholly an integer is not one.
      if (!/^[+-]?\d+$/.test(stripped)) throw new Error(`cannot read "${value}" as integer`);
      const n = Number.parseInt(stripped, 10);
      if (!Number.isSafeInteger(n)) throw new Error(`cannot read "${value}" as integer`);
      return n;
    }
    case "boolean":
      return /^(true|yes|y|1)$/i.test(value.trim());
    default:
      return value;
  }
}
