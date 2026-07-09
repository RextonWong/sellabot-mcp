import type { AuditLog } from "../core/audit.js";
import { logger } from "../core/logger.js";
import type { Platform } from "../core/platform.js";
import type { RoutineResult } from "./shared.js";

export interface PromotionsOptions {
  autoCreateVoucher: boolean;
  weeklyVoucherDiscount: number;
  autoBoostListings: boolean;
  boostTopN: number;
  /** Specific product IDs to boost. When set, overrides boostTopN. */
  boostProductIds: string[];
  /**
   * Boosting costs Shopee credits. When false (default), the routine sends a
   * preview email recommending which items to boost but does NOT execute.
   * Set to true only when you want the daemon to spend credits automatically.
   */
  boostAutoExecute: boolean;
  timezone: string;
}

// Compute ISO strings for next Friday 00:00 and Sunday 23:59:59 in the given timezone.
// Works for whole-hour UTC offsets (covers all of Asia, Europe, Americas).
function nextWeekend(tz: string): { startAt: string; endAt: string } {
  const now = new Date();

  const dayShort = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(dayShort);
  const daysToFriday = (5 - DOW + 7) % 7 || 7;

  const fridayApprox = new Date(now.getTime() + daysToFriday * 86400000);
  const sundayApprox = new Date(fridayApprox.getTime() + 2 * 86400000);

  // sv-SE locale gives "YYYY-MM-DD" which is the local date in the target TZ
  const fridayDate = new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(fridayApprox);
  const sundayDate = new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(sundayApprox);

  function localToUtc(localDateStr: string, h: number, m: number, s: number): string {
    const [yr, mo, da] = localDateStr.split("-").map(Number);
    // Start with UTC midnight for the local date string
    const utcMidnight = new Date(Date.UTC(yr!, mo! - 1, da!, 0, 0, 0));
    // What local hour does UTC midnight correspond to in this TZ?
    const localHr = parseInt(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(utcMidnight),
      10,
    );
    // Derive offset: if localHr ≤ 12 → UTC+localHr; if > 12 → UTC-(24-localHr)
    const offsetH = localHr <= 12 ? localHr : localHr - 24;
    // Local h:m:s = UTC midnight - offsetH + elapsed seconds
    return new Date(utcMidnight.getTime() - offsetH * 3600000 + (h * 3600 + m * 60 + s) * 1000).toISOString();
  }

  return {
    startAt: localToUtc(fridayDate, 0, 0, 0),
    endAt: localToUtc(sundayDate, 23, 59, 59),
  };
}

export async function runPromotions(
  adapter: Platform,
  opts: PromotionsOptions,
  audit: AuditLog,
): Promise<RoutineResult> {
  const lines: string[] = ["WEEKLY PROMOTIONS", ""];
  let urgent = false;

  // ── Auto-voucher ────────────────────────────────────────────────────────────

  if (opts.autoCreateVoucher) {
    try {
      // Find products with 0 recent sales (slow movers)
      const [allProducts, recentOrders] = await Promise.all([
        adapter.getProducts({ status: "live", limit: 100 }),
        adapter.getOrders({ status: "completed", limit: 100 }),
      ]);

      const soldProductIds = new Set<string>();
      for (const order of recentOrders.items) {
        const detail = await adapter.getOrder({ orderId: order.orderId }).catch(() => null);
        if (detail) {
          for (const item of detail.items) soldProductIds.add(item.productId);
        }
      }

      const slowMovers = allProducts.items.filter((p) => !soldProductIds.has(p.productId));
      const { startAt, endAt } = nextWeekend(opts.timezone);
      const scope = slowMovers.length > 0 ? "product" : "shop";
      const productIds = slowMovers.length > 0 ? slowMovers.map((p) => p.productId) : undefined;
      const voucherName =
        slowMovers.length > 0
          ? `Weekend Deal — Slow Movers ${new Date().toLocaleDateString("en-MY")}`
          : `Weekend Deal ${new Date().toLocaleDateString("en-MY")}`;

      const voucher = await adapter.createVoucher({
        name: voucherName,
        discount: { type: "percent", value: opts.weeklyVoucherDiscount },
        startAt,
        endAt,
        scope,
        productIds,
      });

      audit.record({
        tool: "promotions:createVoucher",
        tier: "SENSITIVE",
        effect: `Created ${opts.weeklyVoucherDiscount}% ${scope}-scoped voucher "${voucherName}"`,
        decision: "auto",
        outcome: "executed",
      });

      lines.push("VOUCHER CREATED:");
      if (slowMovers.length > 0) {
        lines.push(`  ${opts.weeklyVoucherDiscount}% off ${slowMovers.length} slow-moving product(s) this weekend`);
      } else {
        lines.push(`  ${opts.weeklyVoucherDiscount}% off entire shop this weekend`);
      }
      lines.push(`  Valid: Fri 00:00 – Sun 23:59 (${opts.timezone})`);
      lines.push(`  Voucher ID: ${voucher.voucherId}`);
    } catch (err) {
      const msg = (err as Error).message;
      logger.error("auto-voucher failed", { error: msg });
      lines.push(`VOUCHER: Failed to create — ${msg}`);
      urgent = true;
    }
    lines.push("");
  }

  // ── Boost listings ──────────────────────────────────────────────────────────
  // Boosting costs Shopee credits. Default is PREVIEW ONLY — the daemon emails
  // a recommendation but does not execute. Set boostAutoExecute=true to spend credits.

  if (opts.autoBoostListings) {
    try {
      // Resolve which products to boost: explicit IDs → top N live listings
      let targetProducts: Array<{ productId: string; name: string }> = [];

      if (opts.boostProductIds.length > 0) {
        // Fetch names for the pinned IDs
        const liveProducts = await adapter.getProducts({ status: "live", limit: 100 });
        const nameMap = new Map(liveProducts.items.map((p) => [p.productId, p.name]));
        targetProducts = opts.boostProductIds.map((id) => ({
          productId: id,
          name: nameMap.get(id) ?? `Product ${id}`,
        }));
      } else {
        const products = await adapter.getProducts({ status: "live", limit: opts.boostTopN });
        targetProducts = products.items.slice(0, opts.boostTopN);
      }

      if (!opts.boostAutoExecute) {
        // ── PREVIEW MODE (default) — no credits spent ──────────────────────
        lines.push("BOOST RECOMMENDATION (preview — no credits spent):");
        lines.push("  To approve, ask Claude: \"boost these listings\" or run:");
        lines.push("  npx tsx scripts/test-routine.ts promotions (with BOOST_AUTO_EXECUTE=true)");
        lines.push("  OR use the MCP tool boost_listing for each product below:");
        lines.push("");
        for (const p of targetProducts) {
          lines.push(`  • ${p.name}  [ID: ${p.productId}]`);
        }
      } else {
        // ── AUTO-EXECUTE MODE — spends Shopee credits ──────────────────────
        const boosted: string[] = [];
        const failed: string[] = [];

        for (const product of targetProducts) {
          try {
            await adapter.boostListing({ productId: product.productId });
            audit.record({
              tool: "promotions:boostListing",
              tier: "SENSITIVE",
              effect: `Boosted listing "${product.name}" (${product.productId})`,
              decision: "auto",
              outcome: "executed",
            });
            boosted.push(product.name);
          } catch (err) {
            failed.push(product.name);
            logger.warn("boost failed", {
              productId: product.productId,
              error: (err as Error).message,
            });
          }
        }

        lines.push("BOOSTED LISTINGS (credits spent):");
        if (boosted.length === 0 && failed.length === 0) lines.push("  No products found.");
        for (const name of boosted) lines.push(`  ✓ ${name}`);
        for (const name of failed) lines.push(`  ✗ ${name} (failed — may already be boosted)`);
      }
    } catch (err) {
      logger.error("boost routine failed", { error: (err as Error).message });
      urgent = true;
      lines.push(`BOOST: Failed — ${(err as Error).message}`);
    }
    lines.push("");
  }

  if (!opts.autoCreateVoucher && !opts.autoBoostListings) {
    lines.push("No promotions configured. Set AUTO_CREATE_VOUCHER=true or AUTO_BOOST_LISTINGS=true.");
  }

  return {
    name: "Weekly Promotions",
    summary: lines.join("\n"),
    urgent,
    data: { autoCreateVoucher: opts.autoCreateVoucher, autoBoostListings: opts.autoBoostListings },
  };
}
