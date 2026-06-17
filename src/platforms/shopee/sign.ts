/**
 * Shopee Open Platform API v2 request signing (HMAC-SHA256).
 *
 * The signature base string differs by call type:
 *   public:         partner_id + api_path + timestamp
 *   shop-scoped:    partner_id + api_path + timestamp + access_token + shop_id
 *   merchant-scoped:partner_id + api_path + timestamp + access_token + merchant_id
 *
 * sign = hex( HMAC_SHA256( key = partner_key, msg = base_string ) )
 *
 * This is the ONLY place signatures are computed. Verified by golden-vector
 * tests in test/shopee/sign.test.ts.
 */
import { createHmac } from "node:crypto";

export interface SignParams {
  partnerId: string;
  partnerKey: string;
  apiPath: string;
  /** Unix seconds. */
  timestamp: number;
}

export interface ShopSignParams extends SignParams {
  accessToken: string;
  shopId: string;
}

function hmac(key: string, message: string): string {
  return createHmac("sha256", key).update(message).digest("hex");
}

/** Public APIs (token exchange/refresh, auth URL). */
export function signPublic(p: SignParams): string {
  const base = `${p.partnerId}${p.apiPath}${p.timestamp}`;
  return hmac(p.partnerKey, base);
}

/** Shop-scoped APIs (all operational calls). */
export function signShop(p: ShopSignParams): string {
  const base = `${p.partnerId}${p.apiPath}${p.timestamp}${p.accessToken}${p.shopId}`;
  return hmac(p.partnerKey, base);
}
