import type { Platform } from "../core/platform.js";
import type { Review } from "../core/models.js";
import type { AuditLog } from "../core/audit.js";
import { logger } from "../core/logger.js";

const POSITIVE_TEMPLATES = [
  "Thank you for your review! We're glad you're happy with your purchase 😊",
  "Thanks for the kind words! We appreciate your support 🙏",
  "Thank you for choosing us! Happy to hear you enjoyed the product 🎉",
  "We're thrilled you love it! Thank you for your feedback ❤️",
  "Thanks for your wonderful review! We hope to serve you again soon 😄",
  "Your support means the world to us! Thank you for the great review ⭐",
  "So glad you're satisfied! Thank you for shopping with us 🛍️",
  "Thank you for taking the time to leave a review! We really appreciate it 🙌",
];

function pickTemplate(): string {
  const idx = Math.floor(Math.random() * POSITIVE_TEMPLATES.length);
  return POSITIVE_TEMPLATES[idx]!;
}

export interface ReviewReplierResult {
  replied: number;
  failed: number;
  negativeForReview: Review[];
}

export async function runReviewReplier(
  adapter: Platform,
  reviews: Review[],
  audit: AuditLog,
): Promise<ReviewReplierResult> {
  const positive = reviews.filter((r) => r.rating >= 4);
  const negative = reviews.filter((r) => r.rating < 4);

  let replied = 0;
  let failed = 0;

  for (const review of positive) {
    const text = pickTemplate();
    try {
      await adapter.replyToReview({ reviewId: review.reviewId, text });
      audit.record({
        tool: "daemon:review-replier",
        tier: "ROUTINE",
        effect: `Auto-replied to ${review.rating}★ review by ${review.buyerName} on product ${review.productId}`,
        decision: "auto",
        outcome: "executed",
      });
      replied++;
      logger.info("auto-replied to review", { reviewId: review.reviewId, rating: review.rating });
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      audit.record({
        tool: "daemon:review-replier",
        tier: "ROUTINE",
        effect: `Failed to auto-reply to review by ${review.buyerName}`,
        decision: "auto",
        outcome: "error",
        error: message,
      });
      logger.error("review reply failed", { reviewId: review.reviewId, error: message });
    }
  }

  return { replied, failed, negativeForReview: negative };
}
