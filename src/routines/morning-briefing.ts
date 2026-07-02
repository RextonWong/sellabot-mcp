import type { AuditLog } from "../core/audit.js";
import type { Platform } from "../core/platform.js";
import type { RoutineResult, RoutineStateEntry } from "./shared.js";
import { formatMoney, nowInTz } from "./shared.js";
import { runReviewReplier } from "./review-replier.js";
import { runCancellationHandler } from "./cancellation-handler.js";
import { runRestockAnalyzer, formatRestockAlerts } from "./restock-analyzer.js";

export interface MorningBriefingOptions {
  lowStockThreshold: number;
  autoReplyReviews: boolean;
  autoAcceptUnpaidCancellations: boolean;
  restockAlertDays: number;
}

export async function runMorningBriefing(
  adapter: Platform,
  state: RoutineStateEntry,
  tz: string,
  opts: MorningBriefingOptions,
  audit: AuditLog,
): Promise<{ result: RoutineResult; updatedState: RoutineStateEntry }> {
  const [lowStock, reviews, returns, cancellations, disputes, toShip] = await Promise.all([
    adapter.getLowStockItems({ threshold: opts.lowStockThreshold, limit: 100 }),
    adapter.getReviews({ replied: false, limit: 50 }),
    adapter.getReturns({ status: "pending", limit: 50 }),
    adapter.getCancellations({ limit: 50 }),
    adapter.getDisputes({ limit: 50 }),
    adapter.getOrders({ status: "to_ship", limit: 100 }),
  ]);

  // Messages can 503 — don't let it break the whole briefing
  const messages = await adapter.getMessages({ status: "unread", limit: 50 }).catch(() => null);

  const lines: string[] = [`MORNING BRIEFING — ${nowInTz(tz)}`, ""];

  // ── Low stock ───────────────────────────────────────────────────────────────
  lines.push(`LOW STOCK (threshold: ${opts.lowStockThreshold} units) — ${lowStock.items.length} item${lowStock.items.length === 1 ? "" : "s"}:`);
  if (lowStock.items.length === 0) {
    lines.push("  All stocked up!");
  } else {
    for (const item of lowStock.items) {
      if (item.variants.length > 0) {
        for (const v of item.variants) {
          if (v.stock !== null && v.stock <= opts.lowStockThreshold) {
            const label = v.stock === 0 ? "OUT OF STOCK!" : `${v.stock} units left`;
            lines.push(`  • ${item.name} / ${v.name} — ${label}`);
          }
        }
      } else {
        const label = item.stock === 0 ? "OUT OF STOCK!" : `${item.stock} units left`;
        lines.push(`  • ${item.name} — ${label}`);
      }
    }
  }

  // ── Restock alerts (sales velocity) ─────────────────────────────────────────
  lines.push("");
  const restockAlerts = await runRestockAnalyzer(adapter, opts.restockAlertDays).catch(() => []);
  lines.push(`RESTOCK ALERTS (running out within ${opts.restockAlertDays} days) — ${restockAlerts.length} product${restockAlerts.length === 1 ? "" : "s"}:`);
  lines.push(...formatRestockAlerts(restockAlerts));

  // ── Reviews ─────────────────────────────────────────────────────────────────
  lines.push("");
  if (opts.autoReplyReviews && reviews.items.length > 0) {
    const reviewResult = await runReviewReplier(adapter, reviews.items, audit);
    lines.push(`REVIEWS — Auto-replied to ${reviewResult.replied} positive review${reviewResult.replied === 1 ? "" : "s"}.${reviewResult.failed > 0 ? ` ${reviewResult.failed} failed.` : ""}`);
    if (reviewResult.negativeForReview.length > 0) {
      lines.push(`  ${reviewResult.negativeForReview.length} negative review${reviewResult.negativeForReview.length === 1 ? "" : "s"} need${reviewResult.negativeForReview.length === 1 ? "s" : ""} your attention:`);
      for (const r of reviewResult.negativeForReview) {
        const stars = "★".repeat(r.rating) + "☆".repeat(5 - r.rating);
        const comment = r.comment.length > 60 ? r.comment.slice(0, 57) + "..." : r.comment;
        lines.push(`    • ${stars} by ${r.buyerName}: "${comment}"`);
      }
    }
  } else {
    lines.push(`REVIEWS NEEDING REPLY (${reviews.items.length}):`);
    if (reviews.items.length === 0) {
      lines.push("  All reviews replied to!");
    } else {
      for (const r of reviews.items) {
        const stars = "★".repeat(r.rating) + "☆".repeat(5 - r.rating);
        const comment = r.comment.length > 60 ? r.comment.slice(0, 57) + "..." : r.comment;
        lines.push(`  • ${stars} by ${r.buyerName}: "${comment}"`);
      }
    }
  }

  // ── Cancellations ───────────────────────────────────────────────────────────
  lines.push("");
  if (opts.autoAcceptUnpaidCancellations && cancellations.items.length > 0) {
    const cancelResult = await runCancellationHandler(adapter, cancellations.items, audit);
    lines.push(`CANCELLATIONS — Auto-accepted ${cancelResult.autoAccepted} unpaid cancellation${cancelResult.autoAccepted === 1 ? "" : "s"}.`);
    if (cancelResult.needsReview.length > 0) {
      lines.push(`  ${cancelResult.needsReview.length} cancellation${cancelResult.needsReview.length === 1 ? "" : "s"} need${cancelResult.needsReview.length === 1 ? "s" : ""} your review:`);
      for (const c of cancelResult.needsReview) {
        lines.push(`    • Cancel #${c.cancellationId} — Order #${c.orderId} — ${c.reason} — ${c.buyerName}`);
      }
    }
  } else {
    lines.push(`PENDING CANCELLATIONS (${cancellations.items.length}):`);
    if (cancellations.items.length === 0) {
      lines.push("  None");
    } else {
      for (const c of cancellations.items) {
        lines.push(`  • Cancel #${c.cancellationId} — Order #${c.orderId} — ${c.reason} — ${c.buyerName}`);
      }
    }
  }

  // ── Returns ─────────────────────────────────────────────────────────────────
  lines.push("");
  lines.push(`PENDING RETURNS (${returns.items.length}):`);
  if (returns.items.length === 0) {
    lines.push("  None");
  } else {
    for (const ret of returns.items) {
      lines.push(`  • Return #${ret.returnId} — Order #${ret.orderId} — ${ret.reason} — ${formatMoney(ret.requestedAmount)}`);
    }
  }

  // ── Disputes ────────────────────────────────────────────────────────────────
  lines.push("");
  lines.push(`ACTIVE DISPUTES (${disputes.items.length}):`);
  if (disputes.items.length === 0) {
    lines.push("  None");
  } else {
    for (const d of disputes.items) {
      lines.push(`  • Dispute #${d.disputeId} — Order #${d.orderId} — ${d.reason} — ${d.buyerName}`);
    }
  }

  // ── Orders to ship ──────────────────────────────────────────────────────────
  lines.push("");
  lines.push(`ORDERS TO SHIP: ${toShip.items.length} order${toShip.items.length === 1 ? "" : "s"} awaiting shipment`);

  // ── Unread messages ─────────────────────────────────────────────────────────
  lines.push("");
  if (!messages) {
    lines.push("UNREAD MESSAGES: Unable to check (Shopee chat API unavailable)");
  } else {
    lines.push(`UNREAD MESSAGES (${messages.items.length}):`);
    if (messages.items.length === 0) {
      lines.push("  All caught up!");
    } else {
      for (const c of messages.items) {
        const preview = c.lastMessage.length > 60 ? c.lastMessage.slice(0, 57) + "..." : c.lastMessage;
        lines.push(`  • ${c.buyerName}: "${preview}"`);
      }
    }
  }

  lines.push("");
  lines.push("Have a productive day!");

  const urgent =
    returns.items.length > 0 ||
    disputes.items.length > 0 ||
    restockAlerts.some((a) => a.daysRemaining <= 1) ||
    lowStock.items.some((s) => s.stock === 0);

  return {
    result: {
      name: "Morning Briefing",
      summary: lines.join("\n"),
      urgent,
      data: {
        lowStock: lowStock.items.length,
        restockAlerts: restockAlerts.length,
        reviews: reviews.items.length,
        returns: returns.items.length,
        cancellations: cancellations.items.length,
        disputes: disputes.items.length,
        toShip: toShip.items.length,
      },
    },
    updatedState: {
      lastRunAt: new Date().toISOString(),
      knownOrderIds: state.knownOrderIds,
      consecutiveFailures: 0,
    },
  };
}
