/**
 * Token storage behind a swappable interface. The v1 implementation is a local
 * SQLite file (Node's built-in `node:sqlite`, no native build needed) with
 * token fields encrypted at rest (AES-256-GCM). The DB file alone is useless
 * without TOKEN_ENCRYPTION_KEY.
 *
 * Keyed by (platform, shopId) so one server can hold tokens for several shops
 * and, later, several platforms.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PlatformName } from "./models.js";

export interface TokenRecord {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number;
  /** Free-form platform metadata (e.g. merchant_id), persisted alongside tokens. */
  meta?: Record<string, unknown>;
}

export interface TokenStore {
  get(platform: PlatformName, shopId: string): TokenRecord | null;
  set(platform: PlatformName, shopId: string, record: TokenRecord): void;
  delete(platform: PlatformName, shopId: string): void;
}

// ── AES-256-GCM helpers ───────────────────────────────────────────────────--

/** Derive a stable 32-byte key from the configured secret (any length/format). */
function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // store as iv.tag.ciphertext, all base64
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
}

function decrypt(payload: string, key: Buffer): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed encrypted token blob");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

// ── SQLite implementation ─────────────────────────────────────────────────--

export class SqliteTokenStore implements TokenStore {
  private db: DatabaseSync;
  private key: Buffer;

  constructor(dbPath: string, encryptionKey: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        platform   TEXT NOT NULL,
        shop_id    TEXT NOT NULL,
        blob       TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (platform, shop_id)
      );
    `);
    this.key = deriveKey(encryptionKey);
  }

  get(platform: PlatformName, shopId: string): TokenRecord | null {
    const row = this.db
      .prepare("SELECT blob FROM tokens WHERE platform = ? AND shop_id = ?")
      .get(platform, shopId) as { blob: string } | undefined;
    if (!row) return null;
    return JSON.parse(decrypt(row.blob, this.key)) as TokenRecord;
  }

  set(platform: PlatformName, shopId: string, record: TokenRecord): void {
    const blob = encrypt(JSON.stringify(record), this.key);
    this.db
      .prepare(
        `INSERT INTO tokens (platform, shop_id, blob, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(platform, shop_id) DO UPDATE SET
           blob = excluded.blob,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      )
      .run(platform, shopId, blob, record.expiresAt, Date.now());
  }

  delete(platform: PlatformName, shopId: string): void {
    this.db.prepare("DELETE FROM tokens WHERE platform = ? AND shop_id = ?").run(platform, shopId);
  }
}
