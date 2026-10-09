import { compress } from "headroom-ai";
import type { AppConfig } from "../config/config.js";
import { proxyBaseUrl } from "./headroomProxy.js";
import { logger } from "../obs/logger.js";

const STACK = "ui-flow";

/**
 * Prompt compression for the discovery loop.
 *
 * Worth doing here specifically: an observation payload is a serialized
 * accessibility tree, which is long, highly repetitive, and grows with every
 * turn of the loop. That is close to the ideal shape for a token compressor.
 *
 * Fails open in every direction — disabled, too small, proxy down, malformed
 * response, or a dropped verbatim literal all return the original prompt.
 */

/**
 * Strings that must survive compression byte-for-byte.
 *
 * Same guard as the reference repo's acceptance-criteria literals, for the same
 * reason: a paraphrase is worse than no compression. If "Username" comes back as
 * "user name" the model targets an element that does not exist, and if an
 * account number is reworded the run acts on the wrong record. Quoted strings,
 * element refs and digit runs are the classes that carry that risk.
 */
export function extractLiterals(prompt: string): string[] {
  const out = new Set<string>();
  for (const m of prompt.matchAll(/"([^"\n]{2,60})"/g)) out.add(m[1]!);
  // The format the aria snapshot actually emits — `textbox [ref=e34]`. These are
  // the handles the model points at; a paraphrased ref resolves to nothing, so
  // losing one makes the whole compression unusable rather than merely lossy.
  for (const m of prompt.matchAll(/\bref=e\d+\b/g)) out.add(m[0]);
  for (const m of prompt.matchAll(/\b\d{4,}\b/g)) out.add(m[0]);
  return [...out];
}

function messageText(message: unknown): string | null {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((p): p is { type: string; text: string } => p?.type === "text" && typeof p?.text === "string")
    .map((p) => p.text)
    .join("");
  return text.length > 0 ? text : null;
}

export async function compressPrompt(prompt: string, cfg: AppConfig): Promise<string> {
  if (!cfg.compression.enabled) return prompt;
  if (prompt.length < cfg.compression.minPromptChars) return prompt;

  try {
    const result = (await compress([{ role: "user", content: prompt }], {
      model: cfg.model,
      // Explicit: the SDK's own default port is not the one we start.
      baseUrl: proxyBaseUrl(),
      fallback: true,
      stack: STACK,
    })) as { messages?: unknown[]; tokensSaved?: number };

    const compressed = messageText(result?.messages?.[0]);
    if (!compressed) {
      logger.warn("[headroom] no usable prompt text returned — sending the original");
      return prompt;
    }

    const dropped = extractLiterals(prompt).filter((lit) => !compressed.includes(lit));
    if (dropped.length > 0) {
      logger.warn(
        `[headroom] compression dropped ${dropped.length} verbatim literal(s) — sending the original`,
      );
      return prompt;
    }

    logger.debug(`[headroom] compressed prompt, ~${result.tokensSaved ?? 0} tokens saved`);
    return compressed;
  } catch (error) {
    logger.warn(`[headroom] compression failed (${(error as Error).message}) — sending the original`);
    return prompt;
  }
}
