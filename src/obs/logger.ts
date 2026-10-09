import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Structured logging with redaction at the boundary (§3.4, §3.5).
 *
 * Redaction happens here, on the way out, rather than at every call site.
 * Call sites forget; a single choke point does not. The rule is deliberately
 * blunt — over-redacting a log line costs nothing, under-redacting one writes
 * regulated data to disk.
 */

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let threshold: Level = (process.env.LOG_LEVEL as Level) ?? "info";
let sink: string | null = null;

/** Registered from the secret store so resolved values never reach a log line. */
const secretValues = new Set<string>();

export function registerSecretValue(value: string): void {
  if (value && value.length >= 4) secretValues.add(value);
}

const PATTERNS: Array<[RegExp, string]> = [
  [/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[email]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]"],
  [/\b(?:\d[ -]*?){13,16}\b/g, "[card]"],
  [/\bjsessionid=[A-Za-z0-9]+/gi, "jsessionid=[redacted]"],
  // Allows a quote after the key ("password":"x"), and a scheme word before the
  // value (Authorization: Bearer abc), which \S+ alone would stop at, leaving
  // the token itself in the log. The value stops at whitespace, a quote, comma
  // or closing brace so a JSON-ish line keeps its shape.
  [
    /\b(api[_-]?key|token|password|secret|authorization)\b["']?\s*[:=]\s*["']?(?:(?:bearer|basic)\s+)?[^\s"',}]+/gi,
    "$1=[redacted]",
  ],
  // Money amounts are real customer data in this domain, not decoration.
  [/\$\s?\d[\d,]*\.\d{2}/g, "[amount]"],
];

export function redact(input: string): string {
  let out = input;
  for (const v of secretValues) out = out.split(v).join("[secret]");
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out;
}

/**
 * Redact the *values* of structured fields rather than the serialized JSON.
 * Running the patterns over `JSON.stringify(fields)` and parsing the result back
 * made the logger throw whenever a pattern consumed a closing quote or brace
 * (`{"note":"password=abc"}`), which aborted whatever run was logging, and left a
 * secret containing a quote or backslash unredacted because its escaped form no
 * longer matched.
 */
function redactFields(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactFields);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactFields(v)]));
  }
  return value;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[threshold]) return;

  const safe = redact(msg);
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: safe,
    ...(fields ? (redactFields(fields) as Record<string, unknown>) : {}),
  };

  // Everything human-facing goes to stderr. stdout carries exactly one thing —
  // the result payload — because a calling agent pipes it straight into a JSON
  // parser, and a stray log line there is a broken contract, not a cosmetic
  // nuisance.
  process.stderr.write(`${line.ts.slice(11, 19)} ${level.padEnd(5)} ${safe}\n`);

  if (sink) appendFileSync(sink, `${JSON.stringify(line)}\n`, "utf8");
}

export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => write("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => write("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => write("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => write("error", m, f),
};

/** Point the JSONL sink at this run's evidence directory. */
export function initFileLog(path: string, level: Level = threshold): void {
  mkdirSync(dirname(path), { recursive: true });
  sink = path;
  threshold = level;
}
