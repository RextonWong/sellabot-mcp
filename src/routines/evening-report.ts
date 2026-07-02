import type { Platform } from "../core/platform.js";
import type { RoutineResult, RoutineStateEntry } from "./shared.js";
import { formatMoney, nowInTz } from "./shared.js";

export async function runEveningReport(
  adapter: Platform,
  state: RoutineStateEntry,
  tz: string,
): Promise<{ result: RoutineResult; updatedState: RoutineStateEntry }> {
  const [performance, toShip, returns, disputes] = await Promise.all([
    adapter.getShopPerformance({ period: "today" }).catch(() => null),
    adapter.getOrders({ status: "to_ship", limit: 100 }),
    adapter.getReturns({ status: "pending", limit: 50 }),
    adapter.getDisputes({ limit: 50 }),
  ]);

  const lines: string[] = [`EVENING REPORT — ${nowInTz(tz)}`, ""];

  // Today's sales
  lines.push("TODAY'S SALES:");
  if (!performance) {
    lines.push("  Unable to fetch performance data (Shopee API unavailable)");
  } else {
    lines.push(`  Orders: ${performance.orders ?? "N/A"}`);
    lines.push(`  Revenue: ${formatMoney(performance.sales)}`);
    lines.push("");
    lines.push("SHOP PERFORMANCE:");
    lines.push(`  Rating: ${performance.rating != null ? `${performance.rating}/5.0` : "N/A"}`);
    lines.push(`  Chat response rate: ${performance.responseRate != null ? `${(performance.responseRate * 100).toFixed(0)}%` : "N/A"}`);
    lines.push(`  Penalty points: ${performance.penaltyPoints ?? "N/A"}`);
  }

  // Still pending
  lines.push("");
  lines.push("STILL PENDING:");
  lines.push(`  Orders to ship: ${toShip.items.length}`);
  lines.push(`  Pending returns: ${returns.items.length}`);
  lines.push(`  Active disputes: ${disputes.items.length}`);

  lines.push("");
  lines.push("Good evening!");

  const urgent = returns.items.length > 0 || disputes.items.length > 0;

  return {
    result: {
      name: "Evening Report",
      summary: lines.join("\n"),
      urgent,
      data: {
        orders: performance?.orders,
        sales: performance?.sales,
        rating: performance?.rating,
        toShip: toShip.items.length,
        returns: returns.items.length,
        disputes: disputes.items.length,
      },
    },
    updatedState: {
      lastRunAt: new Date().toISOString(),
      knownOrderIds: state.knownOrderIds,
      consecutiveFailures: 0,
    },
  };
}
