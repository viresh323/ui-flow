import { createHash } from "node:crypto";

/**
 * Tamper-evidence for a document that moves money.
 *
 * Replay refuses to execute an artifact whose content hash does not match what
 * it carries. That is not paranoia about attackers so much as a guard against
 * the ordinary case: a hand-edited artifact that skipped review, or a partially
 * written file.
 *
 * The hash is over a canonical serialization — keys sorted at every depth — so
 * it is stable across formatters, editors and JSON round-trips.
 */

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/** Hash of everything except the integrity block itself. */
export function contentHash(artifact: Record<string, unknown>): string {
  const { integrity: _omit, ...rest } = artifact;
  return createHash("sha256").update(JSON.stringify(canonical(rest))).digest("hex");
}

export function verifyIntegrity(artifact: Record<string, unknown>): {
  ok: boolean;
  expected: string;
  actual: string;
} {
  const expected = (artifact.integrity as { contentSha256?: string })?.contentSha256 ?? "";
  const actual = contentHash(artifact);
  return { ok: expected === actual, expected, actual };
}
