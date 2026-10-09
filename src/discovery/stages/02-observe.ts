import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiscoveryCtx } from "../types.js";
import { logger } from "../../obs/logger.js";

/**
 * Capture the current state of the surface.
 *
 * A screenshot is taken every step as evidence (§3.5) but only fed to the model
 * when the provider declares vision support — a text-only provider degrades to
 * the accessibility tree rather than failing. The tree is the primary signal
 * either way: it is what a desktop driver can also produce, and it is an order
 * of magnitude cheaper in tokens than an image.
 */
export async function observe(ctx: DiscoveryCtx): Promise<DiscoveryCtx> {
  const observation = await ctx.driver.observe({ screenshot: true });

  if (observation.screenshot) {
    const path = join(ctx.evidenceDir, `step-${String(ctx.stepIndex).padStart(2, "0")}.png`);
    writeFileSync(path, Buffer.from(observation.screenshot, "base64"));
  }

  logger.info(`[observe] step ${ctx.stepIndex} | ${observation.title} | ${observation.tree.length}b tree`);
  return { ...ctx, observation };
}
