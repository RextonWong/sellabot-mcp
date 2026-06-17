/**
 * Compares the local machine clock to Shopee's server clock.
 * Shopee rejects requests whose `timestamp` is outside a ~5-minute window,
 * returning `error_sign` — indistinguishable from a wrong key. This isolates
 * clock skew as a cause.
 *
 *   npx tsx scripts/check-clock.ts
 */
const host = "https://partner.test-stable.shopeemobile.com";

const res = await fetch(`${host}/api/v2/auth/token/get`, { method: "GET" });
const serverDate = res.headers.get("date");
const localNow = new Date();
const serverNow = serverDate ? new Date(serverDate) : null;

console.log(
  `Local clock : ${localNow.toISOString()} (epoch ${Math.floor(localNow.getTime() / 1000)})`,
);
if (serverNow) {
  const skewSec = Math.round((localNow.getTime() - serverNow.getTime()) / 1000);
  console.log(
    `Shopee clock: ${serverNow.toISOString()} (epoch ${Math.floor(serverNow.getTime() / 1000)})`,
  );
  console.log(
    `Skew (local - shopee): ${skewSec} seconds = ${(skewSec / 86400).toFixed(2)} days`,
  );
  console.log(
    Math.abs(skewSec) > 300
      ? ">>> CLOCK SKEW EXCEEDS SHOPEE'S 5-MIN WINDOW — this is the cause of error_sign"
      : ">>> Clock is within tolerance; skew is NOT the cause",
  );
} else {
  console.log("No Date header returned by Shopee.");
}
