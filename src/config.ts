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
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  const raw = {
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
