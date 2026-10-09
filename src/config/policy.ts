import type { TenantConfig } from "./config.js";
import type { Capability } from "../artifact/index.js";
import type { RiskClass } from "../artifact/index.js";

/**
 * The policy gate (§3.4).
 *
 * Two rules, both enforced before a single action reaches the surface:
 *
 *  1. A capability may never widen its own permissions. The effective grant is
 *     the *intersection* of what the tenant allows and what the capability
 *     declares it needs. A capability asking for an origin the tenant never
 *     granted is refused at load time, not discovered mid-run.
 *  2. Risky actions are conservative by default. `irreversible` steps require a
 *     human decision unless the tenant has explicitly opted into auditing them.
 *     Blocking is recoverable; an unintended funds transfer is not.
 */

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; code: string; reason: string };

const ALLOW = { allowed: true } as const;

function deny(code: string, reason: string): PolicyDecision {
  return { allowed: false, code, reason };
}

/** Checked once, when a capability is loaded for a tenant. */
export function authorizeCapability(cap: Capability, tenant: TenantConfig): PolicyDecision {
  if (cap.app.product !== tenant.product) {
    return deny(
      "PRODUCT_MISMATCH",
      `capability targets "${cap.app.product}" but tenant runs "${tenant.product}"`,
    );
  }

  // `requires.origins` lists where a capability may run, so a capability recorded
  // against several deployments (the public demo and a local one) lists them
  // all, and it is usable wherever at least one is granted. That is not a hole:
  // authorizeUrl checks the tenant allowlist again on every navigation, so an
  // origin the tenant never granted can never actually be visited.
  // Compared as origins, not raw strings, so a trailing slash does not make a
  // granted origin look ungranted.
  const granted = new Set(tenant.allow.origins.map(originOf));
  const ungranted = cap.policy.requires.origins.filter((o) => !granted.has(originOf(o)));
  if (ungranted.length === cap.policy.requires.origins.length) {
    return deny(
      "ORIGIN_NOT_GRANTED",
      `none of the capability's origins are granted by tenant ${tenant.tenantId}: ${ungranted.join(", ")}`,
    );
  }

  const forbiddenActions = cap.policy.requires.actions.filter(
    (a) => !tenant.allow.actions.includes(a),
  );
  if (forbiddenActions.length > 0) {
    return deny("ACTION_NOT_GRANTED", `action types not permitted: ${forbiddenActions.join(", ")}`);
  }

  return ALLOW;
}

/**
 * Checked before every navigation. Denies win over allows — an explicitly denied
 * path stays denied even when an allowed prefix would otherwise cover it.
 */
export function authorizeUrl(rawUrl: string, tenant: TenantConfig): PolicyDecision {
  let url: URL;
  try {
    url = new URL(rawUrl, tenant.baseUrl);
  } catch {
    return deny("MALFORMED_URL", `cannot parse "${rawUrl}"`);
  }

  const origin = url.origin;
  if (!tenant.allow.origins.some((o) => originOf(o) === origin)) {
    return deny("ORIGIN_BLOCKED", `${origin} is not in the tenant allowlist`);
  }

  // Match on the path as the server will read it, not as it was typed. The URL
  // parser resolves dot segments but leaves %-escapes, doubled slashes and
  // ;path-parameters alone, and a servlet container undoes all of those. A
  // prefix test on the raw path lets "/app//initializeDB.htm" or
  // "/app/%69nitializeDB.htm" walk past a deny on "/app/initializeDB.htm".
  const path = canonicalPath(url.pathname);
  if (path === null) return deny("MALFORMED_URL", `cannot read the path of "${rawUrl}"`);

  if (tenant.deny.pathPrefixes.some((p) => path.startsWith(canonicalPrefix(p)))) {
    return deny("PATH_DENIED", `${url.pathname} is explicitly denied for this tenant`);
  }

  if (!tenant.allow.pathPrefixes.some((p) => path.startsWith(canonicalPrefix(p)))) {
    return deny("PATH_NOT_ALLOWED", `${url.pathname} is outside the allowed path prefixes`);
  }

  return ALLOW;
}

function originOf(o: string): string {
  try {
    return new URL(o).origin;
  } catch {
    return o;
  }
}

/**
 * The path a server would resolve: percent-decoded (repeatedly, so a double
 * encoding cannot hide), with ;path-parameters such as ;jsessionid= removed from
 * every segment, repeated slashes collapsed, dot segments resolved again after
 * decoding, and lower-cased — some containers match case-insensitively, and an
 * over-broad deny is the safe direction to be wrong in.
 * Returns null for a malformed escape, which the caller refuses.
 */
function canonicalPath(pathname: string): string | null {
  let p = pathname;
  for (let i = 0; i < 3; i += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(p);
    } catch {
      return null;
    }
    if (decoded === p) break;
    p = decoded;
  }
  p = p
    .split("/")
    .map((segment) => segment.split(";")[0] ?? "")
    .join("/")
    .replace(/\/{2,}/g, "/");
  try {
    p = new URL(p.startsWith("/") ? p : `/${p}`, "http://canonical.invalid").pathname;
  } catch {
    return null;
  }
  return p.toLowerCase();
}

/** Prefixes are configuration, so they get the same treatment as the path. */
function canonicalPrefix(prefix: string): string {
  return canonicalPath(prefix) ?? prefix.toLowerCase();
}

/** Checked before every step, using the step's declared risk class. */
export function authorizeStep(
  risk: RiskClass,
  cap: Capability,
  opts: { humanConfirmed: boolean },
): PolicyDecision {
  if (risk !== "irreversible") return ALLOW;

  switch (cap.policy.irreversibleStepPolicy) {
    case "block":
      return deny("IRREVERSIBLE_BLOCKED", "capability policy blocks irreversible steps");
    case "allow_with_audit":
      return ALLOW;
    case "require_human_confirmation":
      return opts.humanConfirmed
        ? ALLOW
        : deny("NEEDS_HUMAN_CONFIRMATION", "irreversible step requires a human decision");
  }
}
