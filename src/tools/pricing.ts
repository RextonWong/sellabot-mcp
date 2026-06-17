import { z } from "zod";
import { mutationTool, readTool, type ToolContext } from "./helpers.js";

export function registerPricingTools(ctx: ToolContext) {
  readTool(ctx, {
    name: "get_price",
    title: "Get price",
    description: "Get the current price of a product and each of its variants.",
    capability: "pricing",
    schema: { product_id: z.string() },
    handler: (a, platform) => platform.getPrice({ productId: a.product_id }),
  });

  mutationTool(ctx, {
    name: "update_price",
    title: "Update price",
    description: "Set the price for one product or a specific variant.",
    tier: "SENSITIVE",
    capability: "pricing",
    schema: {
      product_id: z.string(),
      variant_id: z.string().optional(),
      price: z.number().positive(),
      currency: z.string().optional(),
    },
    effect: (a) =>
      `Set price of product ${a.product_id}${a.variant_id ? ` (variant ${a.variant_id})` : ""} to ${a.price}.`,
    handler: (a, platform) =>
      platform.updatePrice({
        productId: a.product_id,
        variantId: a.variant_id,
        price: { amount: a.price, currency: a.currency ?? "" },
      }),
  });

  mutationTool(ctx, {
    name: "bulk_update_price",
    title: "Bulk update prices",
    description: "Set prices for many products/variants in one call.",
    tier: "SENSITIVE",
    capability: "pricing",
    schema: {
      updates: z
        .array(
          z.object({
            product_id: z.string(),
            variant_id: z.string().optional(),
            price: z.number().positive(),
            currency: z.string().optional(),
          }),
        )
        .min(1),
    },
    effect: (a) => `Update prices for ${a.updates.length} item(s).`,
    handler: (a, platform) =>
      platform.bulkUpdatePrice({
        updates: a.updates.map((u) => ({
          productId: u.product_id,
          variantId: u.variant_id,
          price: { amount: u.price, currency: u.currency ?? "" },
        })),
      }),
  });
}
