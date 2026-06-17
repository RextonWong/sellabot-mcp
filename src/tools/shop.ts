import { z } from "zod";
import { readTool, type ToolContext } from "./helpers.js";

export function registerShopTools(ctx: ToolContext) {
  readTool(ctx, {
    name: "get_shop_info",
    title: "Get shop info",
    description: "Shop profile, region, status, and auth health.",
    handler: (_a, platform) => platform.getShopInfo(),
  });

  readTool(ctx, {
    name: "get_shop_performance",
    title: "Get shop performance",
    description: "Shop KPIs: sales, orders, rating, response rate, penalties.",
    capability: "performance",
    schema: {
      period: z.enum(["today", "7d", "30d"]).optional(),
      metrics: z.array(z.string()).optional(),
    },
    handler: (a, platform) => platform.getShopPerformance({ period: a.period, metrics: a.metrics }),
  });
}
