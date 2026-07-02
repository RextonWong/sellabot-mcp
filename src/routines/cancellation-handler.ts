import type { Platform } from "../core/platform.js";
import type { Cancellation } from "../core/models.js";
import type { AuditLog } from "../core/audit.js";
import { logger } from "../core/logger.js";

export interface CancellationHandlerResult {
  autoAccepted: number;
  needsReview: Cancellation[];
}

export async function runCancellationHandler(
  adapter: Platform,
  cancellations: Cancellation[],
  audit: AuditLog,
): Promise<CancellationHandlerResult> {
  let autoAccepted = 0;
  const needsReview: Cancellation[] = [];

  for (const cancel of cancellations) {
    try {
      const order = await adapter.getOrder({ orderId: cancel.orderId });

      if (order.status === "unpaid") {
        await adapter.respondToCancellation({
          cancellationId: cancel.cancellationId,
          decision: "accept",
          reason: "Auto-accepted: order was unpaid",
        });
        audit.record({
          tool: "daemon:cancellation-handler",
          tier: "CRITICAL",
          effect: `Auto-accepted cancellation for UNPAID order #${cancel.orderId} by ${cancel.buyerName}`,
          decision: "auto",
          outcome: "executed",
        });
        autoAccepted++;
        logger.info("auto-accepted unpaid cancellation", { orderId: cancel.orderId });
      } else {
        needsReview.push(cancel);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit.record({
        tool: "daemon:cancellation-handler",
        tier: "CRITICAL",
        effect: `Failed to handle cancellation for order #${cancel.orderId}`,
        decision: "auto",
        outcome: "error",
        error: message,
      });
      logger.error("cancellation handling failed", { orderId: cancel.orderId, error: message });
      needsReview.push(cancel);
    }
  }

  return { autoAccepted, needsReview };
}
