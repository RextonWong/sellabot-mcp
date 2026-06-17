/**
 * Shared signed-call helpers for sandbox seeding/discovery scripts.
 * Reads the encrypted token straight from the store and signs requests with
 * the shop-scoped scheme — independent of the adapter, so seeding can't be
 * blocked by the consent gate.
 */
import { createHmac, createHash, createDecipheriv } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, shopeeHost } from "../src/config.js";

const cfg = loadConfig();
export const HOST = shopeeHost(cfg.shopee.env);
export const PARTNER_ID = cfg.shopee.partnerId;
export const SHOP_ID = cfg.shopee.shopId ?? "";
const PARTNER_KEY = cfg.shopee.partnerKey;

function accessToken(): string {
  const key = createHash("sha256").update(cfg.tokenStore.encryptionKey, "utf8").digest();
  const db = new DatabaseSync(cfg.tokenStore.dbPath);
  const row = db.prepare("SELECT blob FROM tokens WHERE platform=? AND shop_id=?").get("shopee", SHOP_ID) as { blob: string } | undefined;
  if (!row) throw new Error(`No token for shop ${SHOP_ID}`);
  const [iv, tag, data] = row.blob.split(".");
  if (!iv || !tag || !data) throw new Error("Malformed encrypted token blob");
  const dec = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  dec.setAuthTag(Buffer.from(tag, "base64"));
  const rec = JSON.parse(Buffer.concat([dec.update(Buffer.from(data, "base64")), dec.final()]).toString("utf8"));
  return rec.accessToken as string;
}

const AT = accessToken();

function signedUrl(path: string, extra: Record<string, string | number> = {}): string {
  const ts = Math.floor(Date.now() / 1000);
  const sign = createHmac("sha256", PARTNER_KEY).update(`${PARTNER_ID}${path}${ts}${AT}${SHOP_ID}`).digest("hex");
  const params = new URLSearchParams({ partner_id: PARTNER_ID, timestamp: String(ts), access_token: AT, shop_id: SHOP_ID, sign });
  for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
  return `${HOST}${path}?${params.toString()}`;
}

export async function get(path: string, query: Record<string, string | number> = {}): Promise<any> {
  const res = await fetch(signedUrl(path, query), { method: "GET" });
  return res.json();
}

export async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(signedUrl(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** Multipart image upload to Shopee media space; returns the image_id. */
export async function uploadImage(bytes: Buffer, filename = "seed.jpg"): Promise<string> {
  const path = "/api/v2/media_space/upload_image";
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: "image/jpeg" }), filename);
  const res = await fetch(signedUrl(path), { method: "POST", body: form });
  const json = (await res.json()) as any;
  const id = json?.response?.image_info?.image_id ?? json?.response?.image_id;
  if (!id) throw new Error(`upload_image failed: ${JSON.stringify(json).slice(0, 300)}`);
  return id;
}
