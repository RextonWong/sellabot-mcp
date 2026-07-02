import type { Platform } from "../core/platform.js";
import type { RoutineResult, RoutineStateEntry } from "./shared.js";
import { formatMoney, formatDate, hoursUntil } from "./shared.js";

export async function runOrderMonitor(
  adapter: Platform,
  state: RoutineStateEntry,
  tz: string,
): Promise<{ result: RoutineResult; updatedState: RoutineStateEntry }> {
  const orders = await adapter.getOrders({ status: "to_ship", limit: 100 });
  const knownIds = new Set(state.knownOrderIds);

  const newOrders = orders.items.filter((o) => !knownIds.has(o.orderId));
  const allIds = orders.items.map((o) => o.orderId);

  const approaching: Array<{ orderId: string; buyerName: string; total: string; deadline: string; hoursLeft: number }> = [];
  const overdue: typeof approaching = [];

  for (const order of orders.items) {
    const detail = await adapter.getOrder({ orderId: order.orderId });
    if (!detail.shipByDeadline) continue;
    const hrs = hoursUntil(detail.shipByDeadline);
    const entry = {
      orderId: order.orderId,
      buyerName: order.buyerName,
      total: formatMoney(order.total),
      deadline: formatDate(detail.shipByDeadline, tz),
      hoursLeft: hrs,
    };
    if (hrs < 0) overdue.push(entry);
    else if (hrs < 6) approaching.push(entry);
  }

  const lines: string[] = [`ORDER MONITOR — ${formatDate(new Date().toISOString(), tz)}`, ""];

  lines.push(`NEW ORDERS (${newOrders.length}):`);
  if (newOrders.length === 0) {
    lines.push("  None");
  } else {
    for (const o of newOrders) {
      lines.push(`  • #${o.orderId} — ${o.buyerName} — ${formatMoney(o.total)} — ${formatDate(o.createdAt, tz)}`);
    }
  }

  lines.push("");
  lines.push(`APPROACHING DEADLINE <6h (${approaching.length}):`);
  if (approaching.length === 0) {
    lines.push("  None");
  } else {
    for (const a of approaching) {
      lines.push(`  ⚠ #${a.orderId} — ${a.buyerName} — ${a.total} — DEADLINE: ${a.deadline} (${a.hoursLeft.toFixed(1)}h left)`);
    }
  }

  lines.push("");
  lines.push(`OVERDUE (${overdue.length}):`);
  if (overdue.length === 0) {
    lines.push("  None");
  } else {
    for (const o of overdue) {
      lines.push(`  🚨 #${o.orderId} — ${o.buyerName} — ${o.total} — was due ${o.deadline}`);
    }
  }

  lines.push("");
  lines.push(`Summary: ${orders.items.length} orders to ship. ${newOrders.length} new. ${approaching.length} approaching deadline. ${overdue.length} overdue.`);

  const urgent = overdue.length > 0 || approaching.length > 0;

  return {
    result: {
      name: "Order Monitor",
      summary: lines.join("\n"),
      urgent,
      data: { total: orders.items.length, new: newOrders.length, approaching: approaching.length, overdue: overdue.length },
    },
    updatedState: {
      lastRunAt: new Date().toISOString(),
      knownOrderIds: allIds,
      consecutiveFailures: 0,
    },
  };
}
