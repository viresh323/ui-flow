import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { AppConfig, ProviderName } from "../config/config.js";
import { compressPrompt } from "./compressor.js";
import { logger } from "../obs/logger.js";

/**
 * Provider adapter (modelled on buildasign-dev-agent's services/aiProvider.js).
 *
 * Every call into a model goes through `execute`, so the discovery stages never
 * import a vendor SDK and never learn which provider is behind them. Switching
 * providers is one env var.
 *
 * The seam is LangChain's BaseChatModel rather than a hand-rolled interface:
 * `.bindTools()` and `.invoke()` are shared across providers, so the tool-calling
 * agent loop is written once. `chat` is exposed for exactly that.
 */

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
}

export interface ExecuteOpts {
  system?: string;
  /** base64 PNGs. Silently dropped by providers that declare no vision support. */
  images?: string[];
}

export interface AiProvider {
  name: ProviderName;
  model: string;
  supportsVision: boolean;
  chat: BaseChatModel;
  execute(prompt: string, opts?: ExecuteOpts): Promise<{ text: string; usage: ProviderUsage }>;
}

/**
 * Paces requests so the per-minute limit is never tripped in the first place.
 *
 * On a free tier this is not politeness, it is budget protection: a rejected
 * 429 still counts against the daily allowance, so every avoided 429 is a
 * request kept. Measured limits are lower than documented — one model reported
 * 5/minute against a 20/day cap — so the default paces well under them.
 */
class RateLimiter {
  private readonly stamps: number[] = [];
  constructor(private readonly perMinute: number) {}

  async take(): Promise<void> {
    if (this.perMinute <= 0) return;
    const now = Date.now();
    while (this.stamps.length > 0 && now - this.stamps[0]! > 60_000) this.stamps.shift();
    if (this.stamps.length >= this.perMinute) {
      const waitMs = 60_000 - (now - this.stamps[0]!) + 50;
      logger.debug(`[ai] rate limit reached, pausing ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
      return this.take();
    }
    this.stamps.push(Date.now());
  }
}

/**
 * Free-tier quotas are lower than published and vary per model, so a 429 is a
 * normal event in a long discovery run rather than an exceptional one. The
 * server tells us exactly how long to wait — honouring that is both faster and
 * politer than blind exponential backoff.
 */
async function invokeWithBackoff(
  chat: BaseChatModel,
  messages: Parameters<BaseChatModel["invoke"]>[0],
  limiter: RateLimiter,
  /**
   * Two, not three. A rejected request still counts against the *daily* quota,
   * so every retry spends budget whether or not it succeeds. Generous retries
   * on a free tier are a way to burn a day's allowance in one bad minute.
   */
  maxAttempts = 2,
): Promise<Awaited<ReturnType<BaseChatModel["invoke"]>>> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // Retries go through the limiter too. Without this a 429 retry fires
      // straight back into the per-minute limit, earns another 429, and each
      // failed attempt still consumes a daily request.
      if (attempt > 1) await limiter.take();
      return await chat.invoke(messages);
    } catch (error) {
      const message = (error as Error).message ?? "";
      const is429 = message.includes("429") || /too many requests|quota/i.test(message);
      if (!is429 || attempt >= maxAttempts) throw error;

      // A per-day quota does not recover in a minute, and the API still sends a
      // retryDelay of ~40s with it. Retrying burns wall-clock for nothing, so
      // fail fast and say what would actually help.
      if (/PerDay/i.test(message)) {
        const limit = /"quotaValue"\s*:\s*"(\d+)"/.exec(message)?.[1] ?? "?";
        throw new Error(
          `Daily free-tier quota exhausted for this model (limit ${limit}/day). ` +
            `The quota is per model, so set AI_MODEL to a different one or wait for the daily reset.`,
        );
      }

      const hinted = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message)
        ?? /retry in (\d+(?:\.\d+)?)s/i.exec(message);
      const waitMs = Math.ceil((hinted ? Number(hinted[1]) : 30) * 1000) + 1000;
      logger.warn(`[ai] rate limited; waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

const EMPTY_USAGE: ProviderUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  requests: 0,
};

export function mergeUsage(a: ProviderUsage | null, b: ProviderUsage | null): ProviderUsage {
  const x = a ?? EMPTY_USAGE;
  const y = b ?? EMPTY_USAGE;
  return {
    inputTokens: x.inputTokens + y.inputTokens,
    outputTokens: x.outputTokens + y.outputTokens,
    totalTokens: x.totalTokens + y.totalTokens,
    requests: x.requests + y.requests,
  };
}

interface ProviderSpec {
  supportsVision: boolean;
  apiKeyEnv: string;
  build(model: string, apiKey: string): BaseChatModel;
}

/**
 * Adding a provider is one entry here plus its LangChain package. Nothing else
 * in the system changes — that is the point of routing everything through
 * BaseChatModel.
 */
const PROVIDERS: Record<ProviderName, ProviderSpec> = {
  gemini: {
    supportsVision: true,
    apiKeyEnv: "GOOGLE_API_KEY",
    build: (model, apiKey) =>
      new ChatGoogleGenerativeAI({ model, apiKey, temperature: 0 }) as unknown as BaseChatModel,
  },
  claude: {
    supportsVision: true,
    apiKeyEnv: "ANTHROPIC_API_KEY",
    build: (model, apiKey) =>
      new ChatAnthropic({ model, apiKey, temperature: 0 }) as unknown as BaseChatModel,
  },
};

function readUsage(raw: unknown): ProviderUsage {
  const meta = (raw as { usage_metadata?: Record<string, number> })?.usage_metadata;
  return {
    inputTokens: meta?.input_tokens ?? 0,
    outputTokens: meta?.output_tokens ?? 0,
    totalTokens: meta?.total_tokens ?? 0,
    requests: 1,
  };
}

export function createAiProvider(cfg: AppConfig): AiProvider {
  const spec = PROVIDERS[cfg.provider];
  const apiKey = process.env[spec.apiKeyEnv]?.trim();
  if (!apiKey) {
    throw new Error(
      `AI_PROVIDER="${cfg.provider}" requires ${spec.apiKeyEnv} to be set. ` +
        `Set it in .env, or switch provider with AI_PROVIDER=<${Object.keys(PROVIDERS).join("|")}>.`,
    );
  }

  const chat = spec.build(cfg.model, apiKey);
  const limiter = new RateLimiter(cfg.maxRequestsPerMinute);

  const execute: AiProvider["execute"] = async (prompt, opts = {}) => {
    // The one place that knows about compression, exactly as the reference repo
    // does it: every stage reaches the model through here.
    const compressed = await compressPrompt(prompt, cfg);

    const parts: Array<Record<string, unknown>> = [{ type: "text", text: compressed }];
    if (spec.supportsVision) {
      for (const b64 of opts.images ?? []) {
        parts.push({ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } });
      }
    } else if ((opts.images?.length ?? 0) > 0) {
      logger.warn(`[ai] ${cfg.provider} declares no vision support — ${opts.images!.length} screenshot(s) dropped`);
    }

    const messages = [
      ...(opts.system ? [new SystemMessage(opts.system)] : []),
      new HumanMessage({ content: parts as never }),
    ];

    await limiter.take();
    const res = await invokeWithBackoff(chat, messages, limiter);
    // Some models return content as blocks ([{type:"text", text}]). Serialising
    // the array hands the JSON extractor the block wrapper instead of the
    // model's reply, so every turn failed to parse. Take the text parts.
    const text =
      typeof res.content === "string"
        ? res.content
        : Array.isArray(res.content)
          ? res.content
              .filter((p): p is { type: string; text: string } => (p as { type?: string })?.type === "text" && typeof (p as { text?: unknown })?.text === "string")
              .map((p) => p.text)
              .join("") || JSON.stringify(res.content)
          : JSON.stringify(res.content);
    return { text, usage: readUsage(res) };
  };

  return { name: cfg.provider, model: cfg.model, supportsVision: spec.supportsVision, chat, execute };
}
