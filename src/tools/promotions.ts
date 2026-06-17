import { z } from "zod";
import { mutationTool, pageSchema, readTool, type ToolContext } from "./helpers.js";

export function registerPromotionTools(ctx: ToolContext) {
  readTool(ctx, {
    name: "get_vouchers",
    title: "Get vouchers",
    description: "List shop vouchers/discounts, optionally filtered by status.",
    capability: "vouchers",
    schema: {
      status: z.enum(["upcoming", "ongoing", "expired"]).optional(),
      ...pageSchema,
    },
    handler: (a, platform) =>
      platform.getVouchers({ status: a.status, limit: a.limit, cursor: a.cursor }),
  });

  mutationTool(ctx, {
    name: "create_voucher",
    title: "Create voucher",
    description: "Create a shop or product voucher.",
    tier: "SENSITIVE",
    capability: "vouchers",
    schema: {
      name: z.string(),
      discount_type: z.enum(["fixed", "percent"]),
      discount_value: z.number().positive(),
      discount_cap: z.number().positive().optional().describe("Max discount for percent vouchers."),
      start_at: z.string().describe("ISO 8601 start time."),
      end_at: z.string().describe("ISO 8601 end time."),
      min_spend: z.number().min(0).optional(),
      currency: z.string().optional(),
      usage_limit: z.number().int().positive().optional(),
      scope: z.enum(["shop", "product"]).default("shop"),
      product_ids: z.array(z.string()).optional(),
    },
    effect: (a) =>
      `Create ${a.scope} voucher "${a.name}" (${a.discount_value}${a.discount_type === "percent" ? "%" : ""} off), ${a.start_at} → ${a.end_at}.`,
    handler: (a, platform) =>
      platform.createVoucher({
        name: a.name,
        discount: { type: a.discount_type, value: a.discount_value, cap: a.discount_cap },
        startAt: a.start_at,
        endAt: a.end_at,
        minSpend: a.min_spend != null ? { amount: a.min_spend, currency: a.currency ?? "" } : undefined,
        usageLimit: a.usage_limit,
        scope: a.scope,
        productIds: a.product_ids,
      }),
  });

  mutationTool(ctx, {
    name: "boost_listing",
    title: "Boost listing",
    description: "Boost/feature a listing where the platform supports it.",
    tier: "SENSITIVE",
    capability: "boost",
    schema: {
      product_id: z.string(),
      duration_hours: z.number().int().positive().optional(),
    },
    effect: (a) => `Boost listing ${a.product_id}.`,
    handler: (a, platform) =>
      platform.boostListing({ productId: a.product_id, durationHours: a.duration_hours }),
  });
}
