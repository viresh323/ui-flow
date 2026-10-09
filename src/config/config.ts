import "dotenv/config";
import { z } from "zod";

/**
 * Runtime configuration.
 *
 * Everything that varies per environment or per tenant lives here, never in an
 * artifact. An artifact is bound to a *vendor product* (see Capability.app);
 * the base URL, the credentials and the allowlist are supplied by the tenant
 * config at invocation time. That separation is what lets one recorded flow
 * serve many institutions.
 */

const bool = (v: string | undefined, dflt: boolean) =>
  v === undefined || v.trim() === "" ? dflt : !/^(0|false|no|off)$/i.test(v.trim());

const int = (v: string | undefined, dflt: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : dflt;
};

export const ProviderName = z.enum(["gemini", "claude"]);
export type ProviderName = z.infer<typeof ProviderName>;

export interface TenantConfig {
  tenantId: string;
  /** Base URL for this tenant's instance of the product. */
  baseUrl: string;
  product: string;
  /**
   * What the agent is permitted to touch, for this tenant. Intersected with the
   * capability's own declared `policy.requires` — a capability can narrow this,
   * never widen it.
   */
  allow: {
    origins: string[];
    pathPrefixes: string[];
    actions: string[];
  };
  /**
   * Explicit denies, evaluated after allows. ParaBank's initializeDB.htm wipes
   * the database; it is reachable under an otherwise-legitimate path prefix, so
   * "allowed by prefix" is not good enough on its own.
   */
  deny: { pathPrefixes: string[] };
}

export interface AppConfig {
  provider: ProviderName;
  model: string;
  /**
   * Free-tier request budget. Measured, not documented: gemini-3.5-flash
   * reported quotaValue 5 on a 429, while other models allow more. Per-model,
   * so override it when you switch.
   */
  maxRequestsPerMinute: number;
  maxSteps: number;
  stepTimeoutMs: number;
  headless: boolean;
  runsDir: string;
  checkpointDb: string;
  compression: { enabled: boolean; minPromptChars: number };
  tenant: TenantConfig;
}

/**
 * Default model per provider. Deliberately overridable and deliberately not
 * asserted as correct: Google's free-tier model line moves, and a stale literal
 * here is a confusing 404 at the first call. Set AI_MODEL when the default is
 * not available to your key.
 */
const DEFAULT_MODEL: Record<ProviderName, string> = {
  // Verified callable on the free tier. gemini-3.8-flash exists but answered
  // 503 under load, which is a bad default for a loop that makes a call per
  // step; 2.5-flash is listed but not servable on this key.
  gemini: "gemini-3.6-flash",
  claude: "claude-sonnet-5",
};

const PARABANK_TENANT: TenantConfig = {
  tenantId: process.env.TENANT_ID ?? "local",
  baseUrl: process.env.TARGET_BASE_URL ?? "http://localhost:8080",
  product: "parabank",
  allow: {
    origins: [process.env.TARGET_BASE_URL ?? "http://localhost:8080"],
    pathPrefixes: ["/parabank/"],
    actions: ["navigate", "click", "type", "select", "press", "read"],
  },
  deny: {
    // Wipes and reseeds the database. The test harness may call it; the agent
    // must never be able to reach it, and it sits under an allowed prefix.
    pathPrefixes: ["/parabank/initializeDB.htm", "/parabank/admin.htm"],
  },
};

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const raw = (process.env.AI_PROVIDER ?? "gemini").toLowerCase();
  const parsed = ProviderName.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Unknown AI_PROVIDER "${raw}". Supported: ${ProviderName.options.join(", ")}.`,
    );
  }
  const provider = parsed.data;

  return {
    provider,
    model: process.env.AI_MODEL?.trim() || DEFAULT_MODEL[provider],
    maxRequestsPerMinute: int(process.env.AI_MAX_RPM, 3),
    maxSteps: int(process.env.MAX_STEPS, 25),
    stepTimeoutMs: int(process.env.STEP_TIMEOUT_MS, 15_000),
    headless: bool(process.env.HEADLESS, false),
    runsDir: process.env.RUNS_DIR ?? "runs",
    checkpointDb: process.env.CHECKPOINT_DB ?? "runs/checkpoints.sqlite",
    compression: {
      enabled: bool(process.env.HEADROOM_ENABLED, true),
      minPromptChars: int(process.env.HEADROOM_MIN_PROMPT_CHARS, 8000),
    },
    tenant: PARABANK_TENANT,
    ...overrides,
  };
}
