/**
 * Signed, shop-scoped Shopee API client.
 *
 * Responsibilities:
 *  - sign every request (shop-scoped HMAC scheme)
 *  - proactively refresh the access token before it expires (single-flight)
 *  - unwrap Shopee's { error, message, response } envelope into either a
 *    payload or a typed SellabotError
 *  - one transparent refresh+retry on an invalid/expired-token error
 */
import {
  AuthError,
  PlatformError,
  RateLimitError,
  ValidationError,
} from "../../core/errors.js";
import type { HttpClient } from "../../core/http.js";
import { logger } from "../../core/logger.js";
import type { TokenStore } from "../../core/token-store.js";
import type { ShopeeAuth } from "./auth.js";
import { signShop } from "./sign.js";

export interface ShopeeClientConfig {
  partnerId: string;
  partnerKey: string;
  host: string;
  shopId: string;
}

interface ShopeeEnvelope {
  error?: string;
  message?: string;
  request_id?: string;
  response?: unknown;
  [k: string]: unknown;
}

export interface CallOptions {
  method?: "GET" | "POST";
  /** Extra query params (beyond the common signed ones). */
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

const TOKEN_SAFETY_WINDOW_MS = 10 * 60 * 1000;
const TOKEN_ERRORS = new Set(["error_auth", "invalid_access_token", "invalid_acceess_token", "access_token_expired"]);

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export class ShopeeClient {
  private refreshing: Promise<string> | null = null;

  constructor(
    private cfg: ShopeeClientConfig,
    private http: HttpClient,
    private auth: ShopeeAuth,
    private tokens: TokenStore,
  ) {}

  /** The authorized shop this client operates on. */
  get shopId(): string {
    return this.cfg.shopId;
  }

  /** Returns a valid access token, refreshing proactively if near expiry. */
  private async accessToken(force = false): Promise<string> {
    const rec = this.tokens.get("shopee", this.cfg.shopId);
    if (!rec) {
      throw new AuthError(
        `No tokens stored for Shopee shop ${this.cfg.shopId}. Run \`npm run authorize\` first.`,
      );
    }
    const nearExpiry = rec.expiresAt - Date.now() < TOKEN_SAFETY_WINDOW_MS;
    if (!force && !nearExpiry) return rec.accessToken;

    // single-flight refresh
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          logger.info("refreshing shopee access token", { shopId: this.cfg.shopId });
          const next = await this.auth.refresh(rec.refreshToken, this.cfg.shopId);
          this.tokens.set("shopee", this.cfg.shopId, {
            accessToken: next.accessToken,
            refreshToken: next.refreshToken,
            expiresAt: next.expiresAt,
          });
          return next.accessToken;
        } finally {
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }

  async call<T = unknown>(apiPath: string, opts: CallOptions = {}): Promise<T> {
    try {
      return await this.doCall<T>(apiPath, opts, false);
    } catch (err) {
      if (err instanceof AuthError) {
        // one transparent refresh + retry
        return this.doCall<T>(apiPath, opts, true);
      }
      throw err;
    }
  }

  private async doCall<T>(apiPath: string, opts: CallOptions, forceRefresh: boolean): Promise<T> {
    const accessToken = await this.accessToken(forceRefresh);
    const timestamp = nowSec();
    const sign = signShop({
      partnerId: this.cfg.partnerId,
      partnerKey: this.cfg.partnerKey,
      apiPath,
      timestamp,
      accessToken,
      shopId: this.cfg.shopId,
    });

    const params = new URLSearchParams({
      partner_id: this.cfg.partnerId,
      timestamp: String(timestamp),
      access_token: accessToken,
      shop_id: this.cfg.shopId,
      sign,
    });
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) params.set(k, String(v));
    }

    const method = opts.method ?? (opts.body ? "POST" : "GET");
    const res = await this.http.request({
      method,
      url: `${this.cfg.host}${apiPath}?${params.toString()}`,
      body: opts.body,
      idempotent: method === "GET",
    });

    const env = (res.json ?? {}) as ShopeeEnvelope;
    if (env.error) {
      this.throwForError(env, apiPath);
    }
    return (env.response ?? env) as T;
  }

  private throwForError(env: ShopeeEnvelope, apiPath: string): never {
    const code = env.error ?? "unknown";
    const msg = env.message || code;
    const opts = { code, details: { apiPath, requestId: env.request_id } };

    if (TOKEN_ERRORS.has(code)) throw new AuthError(msg, opts);
    if (code.includes("auth") || code.includes("permission")) throw new AuthError(msg, opts);
    if (code.includes("rate") || code.includes("limit")) throw new RateLimitError(msg);
    if (code.includes("param") || code.includes("invalid")) throw new ValidationError(msg, opts);
    throw new PlatformError(msg, opts);
  }
}
