/**
 * Loads and validates environment configuration with Zod. Single source of
 * truth for runtime config; fails fast with a clear message on bad input.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import type { LogLevel } from "./core/logger.js";

// Load .env from the package root, not process.cwd(): an MCP client (Claude
// Desktop/Code) may spawn this server from an arbitrary working directory.
// This file lives in <root>/dist (or <root>/src under tsx), so root is one up.
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const ShopeeRegion = z.enum(["SG", "MY", "ID", "TH", "VN", "PH", "TW", "BR"]);

const boolish = z
  .string()
  .optional()
  .transform((v) => v?.toLowerCase() === "true");

const ConfigSchema = z.object({
  anthropicApiKey: z.string().optional(),
  shopee: z.object({
    partnerId: z.string().min(1, "SHOPEE_PARTNER_ID is required"),
    partnerKey: z.string().min(1, "SHOPEE_PARTNER_KEY is required"),
    region: ShopeeRegion,
    env: z.enum(["sandbox", "production"]),
    shopId: z.string().optional(),
    redirectUrl: z.string().url().optional(),
  }),
  tokenStore: z.object({
    dbPath: z.string().min(1),
    encryptionKey: z.string().min(16, "TOKEN_ENCRYPTION_KEY must be set (>=16 chars)"),
  }),
  oauth: z.object({
    callbackPort: z.coerce.number().int().positive().default(8787),
  }),
  server: z.object({
    readOnly: z.boolean(),
    logLevel: z.enum(["debug", "info", "warn", "error"]),
    requestTimeoutMs: z.coerce.number().int().positive().default(15000),
    maxRetries: z.coerce.number().int().min(0).default(3),
  }),
  consent: z.object({
    autoConfirmTier: z.enum(["none", "routine"]).default("none"),
    bulkConfirmThreshold: z.coerce.number().int().positive().default(10),
    auditLogPath: z.string().optional(),
  }),
  daemon: z
    .object({
      notifyEmail: z.string().email(),
      smtp: z.object({
        host: z.string().default("smtp.gmail.com"),
        port: z.coerce.number().int().default(587),
        user: z.string().min(1),
        pass: z.string().min(1),
      }),
      ntfyTopic: z.string().optional(),
      telegramBotToken: z.string().optional(),
      telegramChatId: z.string().optional(),
      lowStockThreshold: z.coerce.number().int().min(0).default(5),
      timezone: z.string().default("Asia/Kuala_Lumpur"),
      autoReplyReviews: z.boolean().default(false),
      autoAcceptUnpaidCancellations: z.boolean().default(false),
      restockAlertDays: z.coerce.number().int().min(1).default(7),
      // Phase 3 — Shopee promotions
      autoCreateVoucher: z.boolean().default(false),
      weeklyVoucherDiscount: z.coerce.number().int().min(1).max(90).default(5),
      autoBoostListings: z.boolean().default(false),
      boostTopN: z.coerce.number().int().min(1).default(3),
      // Comma-separated product IDs to boost (overrides top-N if set)
      boostProductIds: z.array(z.string()).default([]),
      // Boost costs Shopee credits — must explicitly opt in to auto-execute
      boostAutoExecute: z.boolean().default(false),
      // Phase 3 — Ad generation
      adGeneratorEnabled: z.boolean().default(true),
      adProductsLimit: z.coerce.number().int().min(1).default(5),
    })
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  const raw = {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
    shopee: {
      partnerId: process.env.SHOPEE_PARTNER_ID ?? "",
      partnerKey: process.env.SHOPEE_PARTNER_KEY ?? "",
      region: process.env.SHOPEE_REGION ?? "MY",
      env: process.env.SHOPEE_ENV ?? "sandbox",
      shopId: process.env.SHOPEE_SHOP_ID || undefined,
      redirectUrl: process.env.SHOPEE_REDIRECT_URL || undefined,
    },
    tokenStore: {
      dbPath: process.env.TOKEN_DB_PATH || "./.data/tokens.db",
      encryptionKey: process.env.TOKEN_ENCRYPTION_KEY ?? "",
    },
    oauth: {
      callbackPort: process.env.OAUTH_CALLBACK_PORT,
    },
    server: {
      readOnly: boolish.parse(process.env.READ_ONLY),
      logLevel: (process.env.LOG_LEVEL as LogLevel) || "info",
      requestTimeoutMs: process.env.REQUEST_TIMEOUT_MS,
      maxRetries: process.env.MAX_RETRIES,
    },
    consent: {
      autoConfirmTier: process.env.AUTO_CONFIRM_TIER || "none",
      bulkConfirmThreshold: process.env.BULK_CONFIRM_THRESHOLD,
      auditLogPath: process.env.AUDIT_LOG_PATH || undefined,
    },
    daemon: process.env.NOTIFY_EMAIL
      ? {
          notifyEmail: process.env.NOTIFY_EMAIL,
          smtp: {
            host: process.env.SMTP_HOST || "smtp.gmail.com",
            port: process.env.SMTP_PORT || 587,
            user: process.env.SMTP_USER || "",
            pass: process.env.SMTP_PASS || "",
          },
          ntfyTopic: process.env.NTFY_TOPIC || undefined,
          telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
          telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
          lowStockThreshold: process.env.LOW_STOCK_THRESHOLD || 5,
          timezone: process.env.TIMEZONE || "Asia/Kuala_Lumpur",
          autoReplyReviews: boolish.parse(process.env.AUTO_REPLY_REVIEWS),
          autoAcceptUnpaidCancellations: boolish.parse(process.env.AUTO_ACCEPT_UNPAID_CANCELLATIONS),
          restockAlertDays: process.env.RESTOCK_ALERT_DAYS || 7,
          autoCreateVoucher: boolish.parse(process.env.AUTO_CREATE_VOUCHER),
          weeklyVoucherDiscount: process.env.WEEKLY_VOUCHER_DISCOUNT || 5,
          autoBoostListings: boolish.parse(process.env.AUTO_BOOST_LISTINGS),
          boostTopN: process.env.BOOST_TOP_N || 3,
          boostProductIds: process.env.BOOST_PRODUCT_IDS
            ? process.env.BOOST_PRODUCT_IDS.split(",").map((s) => s.trim()).filter(Boolean)
            : [],
          boostAutoExecute: boolish.parse(process.env.BOOST_AUTO_EXECUTE),
          adGeneratorEnabled: process.env.AD_GENERATOR_ENABLED !== undefined
            ? boolish.parse(process.env.AD_GENERATOR_ENABLED)
            : undefined,
          adProductsLimit: process.env.AD_PRODUCTS_LIMIT || 5,
        }
      : undefined,
  };

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Shopee API host for the configured environment. */
export function shopeeHost(env: "sandbox" | "production"): string {
  return env === "production"
    ? "https://partner.shopeemobile.com"
    : "https://openplatform.sandbox.test-stable.shopee.sg";
}
