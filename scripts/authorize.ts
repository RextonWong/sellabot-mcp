/**
 * One-time Shopee shop authorization.
 *
 *   npm run authorize           # auto-capture via local callback server
 *   npm run authorize -- --manual   # paste the redirected URL by hand
 *
 * Shopee's console rejects localhost redirect URLs, so:
 *  - Auto mode suits a public tunnel (e.g. ngrok) that forwards to the local
 *    callback server on OAUTH_CALLBACK_PORT.
 *  - Manual mode suits any registered public https URL: you authorize, then
 *    paste the redirected address (which carries ?code=...&shop_id=...) back
 *    into this prompt. No tunnel needed.
 *
 * Either way: exchange code -> persist tokens (encrypted) -> print SHOPEE_SHOP_ID.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig, shopeeHost } from "../src/config.js";
import { HttpClient } from "../src/core/http.js";
import { SqliteTokenStore } from "../src/core/token-store.js";
import { ShopeeAuth } from "../src/platforms/shopee/auth.js";
import { waitForCallback } from "../src/auth/oauth-callback.js";

interface Captured {
  code: string;
  shopId: string;
}

/** Pull code + shop_id out of a pasted redirect URL, or fall back to prompts. */
async function captureManually(): Promise<Captured> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const pasted = (
      await rl.question(
        "\n3. After authorizing, copy the URL your browser was redirected to\n" +
          "   (it contains ?code=...&shop_id=...) and paste it here:\n\n   > ",
      )
    ).trim();

    let code: string | null = null;
    let shopId: string | null = null;

    try {
      const url = new URL(pasted);
      code = url.searchParams.get("code");
      shopId = url.searchParams.get("shop_id");
    } catch {
      // not a full URL — fall through to manual prompts
    }

    if (!code) code = (await rl.question("   Paste the `code` value: ")).trim();
    if (!shopId) shopId = (await rl.question("   Paste the `shop_id` value: ")).trim();

    if (!code || !shopId) throw new Error("Both code and shop_id are required.");
    return { code, shopId };
  } finally {
    rl.close();
  }
}

async function main() {
  const manual = process.argv.includes("--manual");
  const config = loadConfig();
  const redirectUrl =
    config.shopee.redirectUrl ?? `http://localhost:${config.oauth.callbackPort}/callback`;

  const http = new HttpClient({
    timeoutMs: config.server.requestTimeoutMs,
    maxRetries: config.server.maxRetries,
  });
  const auth = new ShopeeAuth(
    {
      partnerId: config.shopee.partnerId,
      partnerKey: config.shopee.partnerKey,
      host: shopeeHost(config.shopee.env),
    },
    http,
  );
  const tokens = new SqliteTokenStore(
    config.tokenStore.dbPath,
    config.tokenStore.encryptionKey,
  );

  const authorizeUrl = auth.buildAuthorizeUrl(redirectUrl);

  console.log("\n1. Open this URL and authorize your shop:\n");
  console.log(`   ${authorizeUrl}\n`);
  console.log(`   (registered redirect: ${redirectUrl})\n`);

  let captured: Captured;
  if (manual) {
    captured = await captureManually();
  } else {
    console.log(`2. Waiting for the redirect to ${redirectUrl} ...`);
    console.log("   (forward this port publicly, e.g. `ngrok http " + config.oauth.callbackPort + "`)\n");
    captured = await waitForCallback(config.oauth.callbackPort);
  }

  console.log(`\n   Received code for shop ${captured.shopId}. Exchanging for tokens...`);
  const token = await auth.exchangeCode(captured.code, captured.shopId);
  tokens.set("shopee", captured.shopId, {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
  });

  console.log("\n✅ Authorization complete. Tokens stored (encrypted).\n");
  console.log("Add this to your .env so the server uses this shop:\n");
  console.log(`   SHOPEE_SHOP_ID=${captured.shopId}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n❌ Authorization failed: ${err?.message ?? err}`);
  if (err?.code) console.error(`   shopee error code: ${err.code}`);
  if (err?.details) console.error(`   details: ${JSON.stringify(err.details)}`);
  console.error("");
  process.exitCode = 1;
});
