import { z } from "zod";
import { mutationTool, pageSchema, readTool, type ToolContext } from "./helpers.js";

export function registerCustomerServiceTools(ctx: ToolContext) {
  readTool(ctx, {
    name: "get_messages",
    title: "Get messages",
    description: "List buyer conversations, optionally only unread ones.",
    capability: "customer_service",
    schema: {
      status: z.enum(["unread", "all"]).optional(),
      ...pageSchema,
    },
    handler: (a, platform) =>
      platform.getMessages({ status: a.status, limit: a.limit, cursor: a.cursor }),
  });

  mutationTool(ctx, {
    name: "reply_to_message",
    title: "Reply to message",
    description: "Send a reply in a buyer conversation.",
    tier: "ROUTINE",
    capability: "customer_service",
    schema: {
      conversation_id: z.string(),
      text: z.string(),
      attachments: z.array(z.string()).optional(),
    },
    effect: (a) => `Reply to conversation ${a.conversation_id}: "${a.text.slice(0, 80)}".`,
    handler: (a, platform) =>
      platform.replyToMessage({
        conversationId: a.conversation_id,
        text: a.text,
        attachments: a.attachments,
      }),
  });

  readTool(ctx, {
    name: "get_reviews",
    title: "Get reviews",
    description: "List product reviews/ratings, optionally filtered by product, rating, or reply state.",
    capability: "reviews",
    schema: {
      product_id: z.string().optional(),
      rating: z.number().int().min(1).max(5).optional(),
      replied: z.boolean().optional(),
      ...pageSchema,
    },
    handler: (a, platform) =>
      platform.getReviews({
        productId: a.product_id,
        rating: a.rating,
        replied: a.replied,
        limit: a.limit,
        cursor: a.cursor,
      }),
  });

  mutationTool(ctx, {
    name: "reply_to_review",
    title: "Reply to review",
    description: "Post a public seller reply to a product review.",
    tier: "ROUTINE",
    capability: "reviews",
    schema: { review_id: z.string(), text: z.string() },
    effect: (a) => `Reply to review ${a.review_id}: "${a.text.slice(0, 80)}".`,
    handler: (a, platform) => platform.replyToReview({ reviewId: a.review_id, text: a.text }),
  });
}
