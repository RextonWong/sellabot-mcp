import { z } from "zod";
import { mutationTool, pageSchema, readTool, type ToolContext } from "./helpers.js";

export function registerInventoryTools(ctx: ToolContext) {
  readTool(ctx, {
    name: "get_stock",
    title: "Get stock",
    description: "Get current stock for a product and each of its variants.",
    capability: "inventory",
    schema: { product_id: z.string() },
    handler: (a, platform) => platform.getStock({ productId: a.product_id }),
  });

  readTool(ctx, {
    name: "get_low_stock_items",
    title: "Get low-stock items",
    description: "List items at or below a stock threshold (default 5).",
    capability: "inventory",
    schema: {
      threshold: z.number().int().min(0).default(5),
      ...pageSchema,
    },
    handler: (a, platform) =>
      platform.getLowStockItems({ threshold: a.threshold, limit: a.limit, cursor: a.cursor }),
  });

  mutationTool(ctx, {
    name: "update_stock",
    title: "Update stock",
    description: "Set the stock quantity for one product or a specific variant.",
    tier: "ROUTINE",
    capability: "inventory",
    schema: {
      product_id: z.string(),
      variant_id: z.string().optional(),
      stock: z.number().int().min(0),
    },
    effect: (a) =>
      `Set stock of product ${a.product_id}${a.variant_id ? ` (variant ${a.variant_id})` : ""} to ${a.stock}.`,
    handler: (a, platform) =>
      platform.updateStock({
        productId: a.product_id,
        variantId: a.variant_id,
        stock: a.stock,
      }),
  });
}
