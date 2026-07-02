import type { Platform } from "../core/platform.js";
import type { Page, OrderSummary } from "../core/models.js";
import { logger } from "../core/logger.js";
import { formatMoney } from "./shared.js";

export interface RestockAlert {
  productId: string;
  name: string;
  currentStock: number;
  dailyVelocity: number;
  daysRemaining: number;
}

export async function runRestockAnalyzer(
  adapter: Platform,
  alertDays: number,
): Promise<RestockAlert[]> {
  // Collect all completed orders (15-day rolling window, paginated)
  const allOrders: OrderSummary[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<OrderSummary> = await adapter.getOrders({
      status: "completed",
      limit: 100,
      cursor: cursor ?? undefined,
    });
    allOrders.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);

  if (allOrders.length === 0) return [];

  // Get line items for each order to count units sold per product
  const salesMap = new Map<string, { name: string; totalSold: number }>();

  for (const summary of allOrders) {
    try {
      const order = await adapter.getOrder({ orderId: summary.orderId });
      for (const item of order.items) {
        const existing = salesMap.get(item.productId);
        if (existing) {
          existing.totalSold += item.quantity;
        } else {
          salesMap.set(item.productId, { name: item.name, totalSold: item.quantity });
        }
      }
    } catch (err) {
      logger.warn("failed to fetch order details for restock analysis", {
        orderId: summary.orderId,
        error: (err as Error).message,
      });
    }
  }

  // Calculate the actual time window from order dates
  const timestamps = allOrders.map((o) => new Date(o.createdAt).getTime());
  const oldest = Math.min(...timestamps);
  const daysInWindow = Math.max(1, (Date.now() - oldest) / (1000 * 60 * 60 * 24));

  // Get current stock and calculate days remaining
  const alerts: RestockAlert[] = [];

  for (const [productId, sales] of salesMap) {
    try {
      const stock = await adapter.getStock({ productId });
      const currentStock = stock.stock ?? 0;
      const dailyVelocity = sales.totalSold / daysInWindow;

      if (dailyVelocity <= 0) continue;

      const daysRemaining = currentStock / dailyVelocity;

      if (daysRemaining <= alertDays) {
        alerts.push({
          productId,
          name: sales.name,
          currentStock,
          dailyVelocity: Math.round(dailyVelocity * 10) / 10,
          daysRemaining: Math.round(daysRemaining * 10) / 10,
        });
      }
    } catch (err) {
      logger.warn("failed to fetch stock for restock analysis", {
        productId,
        error: (err as Error).message,
      });
    }
  }

  alerts.sort((a, b) => a.daysRemaining - b.daysRemaining);
  return alerts;
}

export function formatRestockAlerts(alerts: RestockAlert[]): string[] {
  const lines: string[] = [];
  if (alerts.length === 0) {
    lines.push("  All products have sufficient stock based on sales velocity.");
  } else {
    for (const a of alerts) {
      const urgency = a.daysRemaining <= 1 ? "🚨" : a.daysRemaining <= 3 ? "⚠" : "•";
      lines.push(
        `  ${urgency} ${a.name}: ${a.currentStock} units left, selling ~${a.dailyVelocity}/day → runs out in ~${a.daysRemaining} days`,
      );
    }
  }
  return lines;
}
