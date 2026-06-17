/**
 * Golden-vector tests for Shopee request signing. The expected hex values are
 * computed independently and pinned here, so a regression in base-string
 * construction (field order, missing component) fails loudly.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { signPublic, signShop } from "../../src/platforms/shopee/sign.ts";

const PARTNER_ID = "100123";
const PARTNER_KEY = "partnerkey";
const TIMESTAMP = 1_700_000_000;

test("signShop: partner_id + path + ts + access_token + shop_id", () => {
  const sig = signShop({
    partnerId: PARTNER_ID,
    partnerKey: PARTNER_KEY,
    apiPath: "/api/v2/product/get_item_list",
    timestamp: TIMESTAMP,
    accessToken: "ACCESSTOK",
    shopId: "12345",
  });
  assert.equal(
    sig,
    "65c28b4914801f0950c669575a7775cb7b8680f82efd7381ee22b8447f523669",
  );
});

test("signPublic: partner_id + path + ts", () => {
  const sig = signPublic({
    partnerId: PARTNER_ID,
    partnerKey: PARTNER_KEY,
    apiPath: "/api/v2/auth/token/get",
    timestamp: TIMESTAMP,
  });
  assert.equal(
    sig,
    "98666739282b3aa50162b4eb074575c8721d4c55978c4168b89a2644f4b110c4",
  );
});

test("signature changes when any component changes", () => {
  const base = {
    partnerId: PARTNER_ID,
    partnerKey: PARTNER_KEY,
    apiPath: "/api/v2/product/get_item_list",
    timestamp: TIMESTAMP,
    accessToken: "ACCESSTOK",
    shopId: "12345",
  };
  const a = signShop(base);
  const b = signShop({ ...base, shopId: "54321" });
  assert.notEqual(a, b);
});
