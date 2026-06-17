/**
 * Partner-key signature checker.
 *
 *   npm run check-key
 *
 * Shopee validates the request signature BEFORE it validates the auth code, so
 * we can probe the key by calling /api/v2/auth/token/get with a throwaway code:
 *   - "error_sign"            -> the key (HMAC secret) is wrong
 *   - anything else (e.g.     -> the SIGNING is correct; the key is good
 *      "error_param", "error_auth", invalid code)
 *
 * It tries a few likely key variants so you don't have to edit .env and re-run
 * the whole OAuth flow each time.
 */
import { loadConfig, shopeeHost } from "../src/config.js";
import { HttpClient } from "../src/core/http.js";
import { ShopeeAuth } from "../src/platforms/shopee/auth.js";
import { isSellabotError } from "../src/core/errors.js";

async function probe(
  label: string,
  key: string,
  host: string,
  partnerId: string,
  shopId: string,
) {
  const http = new HttpClient({ timeoutMs: 15000, maxRetries: 0 });
  const auth = new ShopeeAuth({ partnerId, partnerKey: key, host }, http);
  try {
    await auth.exchangeCode("DUMMYCODE000000", shopId);
    console.log(`  ${label}: ✅ unexpectedly succeeded (?)`);
    return "ok";
  } catch (err) {
    const code = isSellabotError(err) ? err.code : undefined;
    if (code === "error_sign") {
      console.log(`  ${label}: ❌ error_sign  (partner exists here, but this key does NOT match it)`);
      return "key_mismatch";
    }
    if (code && (code.includes("partner") || code === "invalid_partner_id")) {
      console.log(`  ${label}: ⚪ ${code}  (partner_id not registered on this host — can't judge the key)`);
      return "wrong_host";
    }
    console.log(`  ${label}: ✅ signing OK — got "${code ?? "?"}" (key matches; error is just the fake code)`);
    return "ok";
  }
}

async function main() {
  const config = loadConfig();
  const raw = config.shopee.partnerKey;
  const partnerId = config.shopee.partnerId;
  const shopId = config.shopee.shopId || "1";

  const keyVariants: Array<[string, string]> = [[`as-is (len ${raw.length})`, raw]];
  if (raw.startsWith("shpk")) {
    const rest = raw.slice(4);
    keyVariants.push([`no "shpk" prefix (len ${rest.length})`, rest]);
    // The part after "shpk" is valid hex -> try the decoded ASCII as the secret.
    if (/^[0-9a-fA-F]+$/.test(rest) && rest.length % 2 === 0) {
      const decoded = Buffer.from(rest, "hex").toString("utf8");
      keyVariants.push([`hex-decoded after "shpk" → "${decoded.slice(0, 6)}…" (len ${decoded.length})`, decoded]);
    }
  }
  // Whole string hex-decoded, in case the console hex-encodes the entire key.
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    const decodedAll = Buffer.from(raw, "hex").toString("utf8");
    keyVariants.push([`whole key hex-decoded (len ${decodedAll.length})`, decodedAll]);
  }

  const hosts: Array<[string, string]> = [
    ["TEST  (test-stable)", shopeeHost("sandbox")],
    ["PROD  (shopeemobile)", shopeeHost("production")],
  ];

  console.log(`\npartner_id=${partnerId}, configured env=${config.shopee.env}\n`);

  let success: string | null = null;
  let partnerKnownSomewhere = false;
  for (const [hostLabel, host] of hosts) {
    console.log(`── ${hostLabel} ──`);
    for (const [keyLabel, key] of keyVariants) {
      const result = await probe(keyLabel, key, host, partnerId, shopId);
      if (result === "ok" && !success) success = `host=${hostLabel.trim()}, key=${keyLabel}`;
      if (result === "key_mismatch") partnerKnownSomewhere = true;
    }
    console.log("");
  }

  if (success) {
    console.log(`→ Signing works with: ${success}`);
    console.log("  Set SHOPEE_ENV / SHOPEE_PARTNER_KEY to match that combination, then re-authorize.\n");
  } else if (partnerKnownSomewhere) {
    console.log(
      `→ partner_id ${partnerId} IS registered (it returned error_sign, not invalid_partner_id),\n` +
        "  but your SHOPEE_PARTNER_KEY does not match it. You've paired the right partner_id with\n" +
        "  the WRONG key. Open this exact app in the Shopee console and copy ITS partner key.\n",
    );
  } else {
    console.log(
      `→ partner_id ${partnerId} isn't recognized on either host. Re-check the partner_id itself.\n`,
    );
  }
  process.exitCode = 0;
}

main().catch((err) => {
  console.error(`\ncheck-key failed: ${err?.message ?? err}\n`);
  process.exitCode = 1;
});
