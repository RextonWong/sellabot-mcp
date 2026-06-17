/**
 * Shopee platform factory: composes auth + signed client + adapter from config.
 */
import type { Config } from "../../config.js";
import { shopeeHost } from "../../config.js";
import { ValidationError } from "../../core/errors.js";
import type { HttpClient } from "../../core/http.js";
import type { TokenStore } from "../../core/token-store.js";
import { ShopeeAdapter } from "./adapter.js";
import { ShopeeAuth } from "./auth.js";
import { ShopeeClient } from "./client.js";

/** Currency per Shopee region (used to stamp canonical Money values). */
const REGION_CURRENCY: Record<string, string> = {
  SG: "SGD",
  MY: "MYR",
  ID: "IDR",
  TH: "THB",
  VN: "VND",
  PH: "PHP",
  TW: "TWD",
  BR: "BRL",
};

export function createShopeeAdapter(
  config: Config,
  http: HttpClient,
  tokens: TokenStore,
): ShopeeAdapter {
  const host = shopeeHost(config.shopee.env);
  const auth = new ShopeeAuth(
    { partnerId: config.shopee.partnerId, partnerKey: config.shopee.partnerKey, host },
    http,
  );

  if (!config.shopee.shopId) {
    throw new ValidationError(
      "SHOPEE_SHOP_ID is not set. Run `npm run authorize` to authorize a shop first.",
    );
  }

  const client = new ShopeeClient(
    {
      partnerId: config.shopee.partnerId,
      partnerKey: config.shopee.partnerKey,
      host,
      shopId: config.shopee.shopId,
    },
    http,
    auth,
    tokens,
  );

  const currency = REGION_CURRENCY[config.shopee.region] ?? "MYR";
  return new ShopeeAdapter(client, currency);
}

export { ShopeeAuth } from "./auth.js";
