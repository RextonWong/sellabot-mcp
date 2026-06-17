/** Seed one product into the sandbox shop so get_products returns real data. */
import { get, post, uploadImage } from "./seed-helpers.js";

console.log("fetching a sample image...");
const imgBytes = Buffer.from(await (await fetch("https://picsum.photos/800")).arrayBuffer());
const imageId = await uploadImage(imgBytes);
console.log(`uploaded image_id: ${imageId}`);

// Valid brand for the category (so brand validation can't mask logistics errors).
const bl = await get("/api/v2/product/get_brand_list", { category_id: 300419, page_size: 10, offset: 0, status: 1 });
const b = bl?.response?.brand_list?.[0];
const brand = b ? { brand_id: b.brand_id, original_brand_name: b.original_brand_name } : { brand_id: 0 };
console.log(`brand: ${JSON.stringify(brand)}\n`);

const base = {
  original_price: 29.9,
  description: "Sellabot smoke-test product, created via the MCP server seeding script.",
  weight: 0.5,
  item_name: "Sellabot Test Widget",
  category_id: 300419,
  brand,
  item_status: "NORMAL",
  dimension: { package_length: 10, package_width: 10, package_height: 10 },
  seller_stock: [{ stock: 50 }],
  image: { image_id_list: [imageId] },
  condition: "NEW",
};

const variants: Array<[string, unknown]> = [
  ["size_id:0+fee", [{ logistics_channel_id: 21012, enabled: true, size_id: 0, shipping_fee: 5 }]],
  ["fee only",       [{ logistics_channel_id: 21012, enabled: true, shipping_fee: 5 }]],
  ["is_free",        [{ logistics_channel_id: 21012, enabled: true, is_free: true }]],
  ["size_id:0+free", [{ logistics_channel_id: 21012, enabled: true, size_id: 0, is_free: true }]],
  ["24000 size_id:0+fee", [{ logistics_channel_id: 24000, enabled: true, size_id: 0, shipping_fee: 5 }]],
];

for (const [label, logistics_info] of variants) {
  const res = await post("/api/v2/product/add_item", { ...base, logistics_info });
  if (res?.error) {
    console.log(`[${label}] ❌ ${res.error} — ${res.message}`);
    continue;
  }
  console.log(`\n✅ [${label}] created item_id: ${res?.response?.item_id}`);
  const list = await get("/api/v2/product/get_item_list", { offset: 0, page_size: 20, item_status: "NORMAL" });
  console.log(`shop now has ${list?.response?.total_count ?? "?"} NORMAL item(s).`);
  process.exit(0);
}
console.log("\nAll logistics variants rejected — sandbox shop has no add_item-usable channel.");
process.exit(1);
