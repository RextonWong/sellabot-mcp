/**
 * npm run export-tokens
 *
 * Reads the local encrypted SQLite token store and prints each token as a
 * JSON string suitable for pasting into the SHOPEE_SEED_TOKEN env var on
 * Render (or any other cloud deployment that starts with an empty DB).
 *
 * Run this BEFORE deploying to Render, then paste the output into Render's
 * environment variables. The JSON is the exact shape TokenStore.set() expects:
 *   { accessToken, refreshToken, expiresAt, meta? }
 *
 * Usage:
 *   npx tsx scripts/export-tokens.ts
 */

import { loadConfig } from "../src/config.js";
import { SqliteTokenStore } from "../src/core/token-store.js";

const config = loadConfig();
const store = new SqliteTokenStore(
  config.tokenStore.dbPath,
  config.tokenStore.encryptionKey,
);

const shopId = config.shopee.shopId;
if (!shopId) {
  console.error("No SHOPEE_SHOP_ID set in config — nothing to export.");
  process.exit(1);
}

const record = store.get("shopee", shopId);
if (!record) {
  console.error(`No token found for shopee / shop ${shopId}. Run \`npm run authorize\` first.`);
  process.exit(1);
}

const expiresIn = Math.round((record.expiresAt - Date.now()) / 1000 / 60);
console.log(`\nShopee token for shop ${shopId}`);
console.log(`Expires: ${new Date(record.expiresAt).toISOString()} (~${expiresIn} min from now)`);
console.log(`\nPaste this as SHOPEE_SEED_TOKEN in Render:\n`);
console.log(JSON.stringify(record));
console.log(`\nNote: access tokens expire in ~4h. On Render, the daemon will`);
console.log(`auto-refresh using the embedded refresh token — no manual re-export needed.`);
