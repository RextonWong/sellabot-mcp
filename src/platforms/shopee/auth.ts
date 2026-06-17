/**
 * Shopee OAuth2: build the authorization URL, exchange the auth code for
 * tokens, and refresh expired access tokens. All calls here use the
 * public-API signing scheme (no access_token in the base string).
 */
import { AuthError } from "../../core/errors.js";
import type { HttpClient } from "../../core/http.js";
import { PATHS } from "./endpoints.js";
import { signPublic } from "./sign.js";

export interface ShopeeAuthConfig {
  partnerId: string;
  partnerKey: string;
  host: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expire_in?: number; // seconds
  error?: string;
  message?: string;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export class ShopeeAuth {
  constructor(
    private cfg: ShopeeAuthConfig,
    private http: HttpClient,
  ) {}

  /** URL the seller opens to authorize a shop. Shopee redirects to redirectUrl?code=...&shop_id=... */
  buildAuthorizeUrl(redirectUrl: string): string {
    const timestamp = nowSec();
    const sign = signPublic({
      partnerId: this.cfg.partnerId,
      partnerKey: this.cfg.partnerKey,
      apiPath: PATHS.authShopAuthPartner,
      timestamp,
    });
    if (process.env.SHOPEE_DEBUG_SIGN === "true") {
      const baseString = `${this.cfg.partnerId}${PATHS.authShopAuthPartner}${timestamp}`;
      console.error("\n[debug] signing inputs for the authorize URL:");
      console.error(`  host         : ${this.cfg.host}`);
      console.error(`  partner_id   : ${this.cfg.partnerId}`);
      console.error(`  api_path     : ${PATHS.authShopAuthPartner}`);
      console.error(`  timestamp    : ${timestamp}`);
      console.error(`  base_string  : ${baseString}`);
      console.error(`  partner_key  : len=${this.cfg.partnerKey.length}, starts="${this.cfg.partnerKey.slice(0, 6)}…"`);
      console.error(`  sign         : ${sign}\n`);
    }
    const params = new URLSearchParams({
      partner_id: this.cfg.partnerId,
      timestamp: String(timestamp),
      sign,
      redirect: redirectUrl,
    });
    return `${this.cfg.host}${PATHS.authShopAuthPartner}?${params.toString()}`;
  }

  /** Exchange the one-time auth code for access + refresh tokens. */
  async exchangeCode(code: string, shopId: string): Promise<TokenResponse> {
    return this.tokenCall(PATHS.authTokenGet, {
      code,
      shop_id: Number(shopId),
      partner_id: Number(this.cfg.partnerId),
    });
  }

  /** Trade a refresh token for a fresh access token (returns a new refresh token too). */
  async refresh(refreshToken: string, shopId: string): Promise<TokenResponse> {
    return this.tokenCall(PATHS.authAccessTokenGet, {
      refresh_token: refreshToken,
      shop_id: Number(shopId),
      partner_id: Number(this.cfg.partnerId),
    });
  }

  private async tokenCall(apiPath: string, body: Record<string, unknown>): Promise<TokenResponse> {
    const timestamp = nowSec();
    const sign = signPublic({
      partnerId: this.cfg.partnerId,
      partnerKey: this.cfg.partnerKey,
      apiPath,
      timestamp,
    });
    const params = new URLSearchParams({
      partner_id: this.cfg.partnerId,
      timestamp: String(timestamp),
      sign,
    });
    const res = await this.http.request({
      method: "POST",
      url: `${this.cfg.host}${apiPath}?${params.toString()}`,
      body,
      idempotent: false,
    });
    const data = (res.json ?? {}) as RawTokenResponse;
    if (process.env.SHOPEE_DEBUG_SIGN === "true") {
      console.error("\n[debug] token exchange request/response:");
      console.error(`  api_path     : ${apiPath}`);
      console.error(`  base_string  : ${this.cfg.partnerId}${apiPath}${timestamp}`);
      console.error(`  sign         : ${sign}`);
      console.error(`  http status  : ${res.status}`);
      console.error(`  raw response : ${res.rawText.slice(0, 500)}\n`);
    }
    if (!data.access_token || !data.refresh_token || !data.expire_in) {
      throw new AuthError(`Shopee token request failed: ${data.error || "unknown"} — ${data.message || "(no message)"}`, {
        code: data.error,
        details: { message: data.message, status: res.status, raw: res.rawText.slice(0, 500) },
      });
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      // refresh slightly early via the safety window in the client
      expiresAt: Date.now() + data.expire_in * 1000,
    };
  }
}
