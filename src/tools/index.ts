import type { ToolContext } from "./helpers.js";
import { registerCustomerServiceTools } from "./customer-service.js";
import { registerInventoryTools } from "./inventory.js";
import { registerOrderTools } from "./orders.js";
import { registerProductTools } from "./products.js";
import { registerPricingTools } from "./pricing.js";
import { registerPromotionTools } from "./promotions.js";
import { registerReturnTools } from "./returns.js";
import { registerShopTools } from "./shop.js";

export function registerAllTools(ctx: ToolContext) {
  registerProductTools(ctx);
  registerPricingTools(ctx);
  registerInventoryTools(ctx);
  registerCustomerServiceTools(ctx);
  registerOrderTools(ctx);
  registerReturnTools(ctx);
  registerPromotionTools(ctx);
  registerShopTools(ctx);
}
