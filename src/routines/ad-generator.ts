import { logger } from "../core/logger.js";
import type { Product } from "../core/models.js";
import type { Platform } from "../core/platform.js";
import type { InstagramClient } from "../platforms/instagram/client.js";
import { formatMoney, type RoutineResult } from "./shared.js";

export interface AdCopySet {
  productId: string;
  productName: string;
  price: string;
  imageUrl: string | null;
  shopee: string;
  facebook: string;
  instagram: string;
  tiktok: string;
}

// ── Template banks (5 variations each, randomised per product) ────────────────

const FACEBOOK_TEMPLATES = [
  "🛍️ Looking for {name}? We've got you covered!\n\nGet yours now at just {price} — limited stock available!\n\n📦 Fast shipping | ⭐ Quality guaranteed\n\nShop now on Shopee! 🛒\n\n#onlineshopping #shopee #malaysia #deals #musthave",
  "Hey shoppers! 👋 Have you checked out our {name}?\n\nFor only {price}, you get quality you can trust. Don't miss out!\n\n✅ Secure payment | 🚚 Quick delivery\n\nFind us on Shopee! 🛒\n\n#shopeemalaysia #buynow #deals #onlineshopping",
  "✨ {name} — your new favourite find!\n\nAt {price}, it's a steal. Grab yours before it's gone!\n\n💯 Trusted seller | ⚡ Ready to ship\n\nSearch for us on Shopee today! 🛍️\n\n#shopeedeals #malaysia #musthave #sale",
  "We know you've been looking for the perfect {name} 🎯\n\nWell, the wait is over! Now available at {price}.\n\n🌟 Quality guaranteed | 📦 Ships fast\n\nShop on Shopee today! 🛒\n\n#shopee #onlineshopping #musthave #malaysia",
  "🔥 {name} is now available!\n\nOnly {price} — shop smart, shop Shopee! 💰\n\n🏆 Trusted seller | ⭐ 5-star quality\n\nOrder now before stock runs out! 📲\n\n#deals #shopeemalaysia #sale #onlineshopping",
];

const INSTAGRAM_TEMPLATES = [
  "✨ {name} is here! Grab yours for only {price} 🛍️\n\nTap link in bio to shop on Shopee!\n\n#shopee #shopeemalaysia #onlineshopping #deals #malaysia #musthave #sale #shoppingaddict #instashop #shopnow",
  "💫 {name} — {price}\n\nLimited stocks! Don't sleep on this 😍\n\nShop via Shopee, link in bio 👆\n\n#shopeemalaysia #newcollection #instashopping #deals #malaysia #onlineshopping #sale #igshop #musthave #shopnow",
  "🛒 {name}\nOnly {price} on Shopee!\n\nQuality you can trust, prices you'll love 💕\n\nLink in bio! 🔗\n\n#shopee #malaysia #deals #onlineshopping #shopeedeals #sale #igshop #instashop #musthave #lifestyle",
  "You deserve nice things ✨\n{name} at {price} 💅\n\nFind it on Shopee 🛍️ Link in bio!\n\n#treatyourself #shopee #malaysia #deals #onlineshopping #sale #musthave #shopeemalaysia #instashop #lifestyle",
  "🔥 Don't miss this! {name} now at {price}\n\nFast shipping + quality guaranteed 🛒\n\nLink in bio 👆\n\n#shopeedeals #malaysia #onlineshopping #sale #deals #shopee #instashop #igshop #musthave #shopnow",
];

const TIKTOK_TEMPLATES = [
  "POV: You just found the best deal on {name} 🤩\n\n✅ Only {price}\n✅ Fast shipping\n✅ Quality guaranteed\n\nShop on Shopee now! 🛍️\n\n#shopee #shopeemalaysia #tiktokmademebuyit #deals #onlineshopping #fyp #foryou #malaysia #musthave #sale",
  "Wait— you NEED to see this {name} 👀\n\n💰 Just {price} on Shopee!\n📦 Ships fast\n⭐ Top rated seller\n\nComment 'LINK' for the Shopee link! 💬\n\n#tiktokmademebuyit #shopee #malaysia #deals #fyp #foryoupage #onlineshopping #musthave #viral #shopeemalaysia",
  "Things I found on Shopee that are actually worth it 💯\n\n👉 {name} — only {price}!\n\nNo cap this is a good deal 🔥\n\n#shopee #shopeehaul #tiktokmademebuyit #fyp #deals #malaysia #onlineshopping #foryou #musthave #viral",
  "The {name} you needed 👇\n\n✨ {price} on Shopee\n✨ Link in bio\n✨ You're welcome 😌\n\n#shopee #malaysia #fyp #foryoupage #deals #onlineshopping #tiktokmademebuyit #musthave #sale #shopeemalaysia",
  "Shopee find of the week: {name} 🛍️\n\n🏷️ Price: {price}\n🚚 Fast delivery\n💯 Trusted seller\n\nComment 'SHOP' for the link! 🔗\n\n#shopeemalaysia #fyp #deals #tiktokmademebuyit #onlineshopping #malaysia #foryou #viral #musthave #shopnow",
];

const SHOPEE_TEMPLATES = [
  "✨ {name}\n\nLooking for a quality {name}? Look no further!\n\n✅ Premium quality\n✅ Carefully packaged\n✅ Fast delivery across Malaysia\n✅ Responsive seller (reply within 1 hour)\n\n📦 Order now and receive within 2–5 business days!\n\n🌟 Join hundreds of happy customers. Add to cart now!",
  "🛍️ {name}\n\n🔥 Why choose us?\n\n✓ High quality, long-lasting\n✓ Safely packaged for delivery\n✓ 100% authentic product\n✓ Friendly customer service\n\n📲 Click 'Add to Cart' and we'll handle the rest!\n\n⭐ Rated 5 stars — shop with confidence!",
  "💫 {name} — Quality You Can Trust!\n\nBest value {name} on Shopee!\n\n📌 Premium quality\n📌 Secure packaging\n📌 Delivery tracking included\n\n✅ Easy returns | ✅ Ships within 24 hours\n\nOrder now! 🛒",
  "⚡ {name}\n\nWhy our buyers keep coming back:\n\n🌟 Premium quality at unbeatable price\n🚀 Ships within 1 working day\n💬 Fast chat support\n🔒 Buyer protection guaranteed\n\n👉 Add to Cart now before stock runs out!",
  "🎯 {name} — The Smart Choice!\n\n✨ Excellent quality\n✨ Value for money\n✨ Trusted seller with verified reviews\n✨ Ships fast to all states in Malaysia\n\n💡 Not sure? Chat with us first!\n\n🛒 Limited stocks. Order yours today!",
];

function pickTemplate(templates: readonly string[]): string {
  return templates[Math.floor(Math.random() * templates.length)]!;
}

function fill(template: string, product: Product): string {
  const price = product.price
    ? `${product.price.currency} ${product.price.amount.toFixed(2)}`
    : "great price";
  return template.replace(/\{name\}/g, product.name).replace(/\{price\}/g, price);
}

// ── Claude API (uses native fetch, no SDK needed) ─────────────────────────────

interface ClaudeAdCopy {
  shopee: string;
  facebook: string;
  instagram: string;
  tiktok: string;
}

async function generateWithClaude(product: Product, apiKey: string): Promise<ClaudeAdCopy> {
  const price = product.price
    ? `${product.price.currency} ${product.price.amount.toFixed(2)}`
    : "contact for price";

  const prompt = `You are a social media marketing expert for a Malaysian Shopee seller. Generate ad copy for this product:

Product: ${product.name}
Price: ${price}
Description: ${product.description ?? "(none)"}

Write 4 pieces of ad copy and respond with valid JSON only (no markdown, no explanation):
{
  "shopee": "SEO listing description: 4-5 bullet points with emojis, highlights quality, mentions fast shipping to Malaysia",
  "facebook": "Conversational post: 2-3 short paragraphs with emojis, ends with call to action and 5 relevant hashtags for Malaysian market",
  "instagram": "Short caption: 2-3 lines max, ends with exactly 10 relevant hashtags for Malaysian market",
  "tiktok": "TikTok caption: trending hook + 3 bullet points + 10 viral hashtags, casual Gen-Z/millennial tone"
}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as { content: Array<{ type: string; text?: string }> };
  const text = data.content[0]?.type === "text" ? (data.content[0].text ?? "{}") : "{}";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON found in Claude response");

  return JSON.parse(jsonMatch[0]) as ClaudeAdCopy;
}

// ── Main generator ─────────────────────────────────────────────────────────────

async function generateAdCopy(product: Product, anthropicApiKey?: string): Promise<ClaudeAdCopy> {
  if (anthropicApiKey) {
    try {
      return await generateWithClaude(product, anthropicApiKey);
    } catch (err) {
      logger.warn("Claude ad generation failed, falling back to templates", {
        product: product.name,
        error: (err as Error).message,
      });
    }
  }
  return {
    shopee: fill(pickTemplate(SHOPEE_TEMPLATES), product),
    facebook: fill(pickTemplate(FACEBOOK_TEMPLATES), product),
    instagram: fill(pickTemplate(INSTAGRAM_TEMPLATES), product),
    tiktok: fill(pickTemplate(TIKTOK_TEMPLATES), product),
  };
}

export async function runAdGenerator(
  adapter: Platform,
  opts: {
    limit: number;
    anthropicApiKey?: string;
    instagramClient?: InstagramClient;
    autoPostInstagram?: boolean;
  },
): Promise<{ copies: AdCopySet[]; result: RoutineResult }> {
  const products = await adapter.getProducts({ status: "live", limit: opts.limit });
  const mode = opts.anthropicApiKey ? "AI-generated (Claude Haiku)" : "template-based";
  const copies: AdCopySet[] = [];

  for (const product of products.items) {
    const copy = await generateAdCopy(product, opts.anthropicApiKey);
    copies.push({
      productId: product.productId,
      productName: product.name,
      price: formatMoney(product.price),
      imageUrl: product.images[0] ?? null,
      ...copy,
    });
  }

  // ── Instagram auto-posting ─────────────────────────────────────────────────
  const igResults: Array<{ name: string; ok: boolean; error?: string }> = [];
  if (opts.autoPostInstagram && opts.instagramClient) {
    for (const copy of copies) {
      if (!copy.imageUrl) {
        igResults.push({ name: copy.productName, ok: false, error: "no image URL" });
        continue;
      }
      try {
        await opts.instagramClient.postPhoto(copy.imageUrl, copy.instagram);
        igResults.push({ name: copy.productName, ok: true });
        logger.info("posted to Instagram", { product: copy.productName });
      } catch (err) {
        const error = (err as Error).message;
        igResults.push({ name: copy.productName, ok: false, error });
        logger.error("Instagram post failed", { product: copy.productName, error });
      }
    }
  }

  const summary = formatAdPackEmail(copies, mode, igResults);

  return {
    copies,
    result: {
      name: "Weekly Ad Pack",
      summary,
      urgent: igResults.some((r) => !r.ok && r.error !== "no image URL"),
      data: { products: copies.length, mode, instagramPosted: igResults.filter((r) => r.ok).length },
    },
  };
}

export function formatAdPackEmail(
  copies: AdCopySet[],
  mode: string,
  igResults: Array<{ name: string; ok: boolean; error?: string }> = [],
): string {
  const border = "═".repeat(50);
  const divider = "─".repeat(50);
  const lines: string[] = [
    `WEEKLY AD PACK — ${copies.length} product(s) — ${mode}`,
    `Generated: ${new Date().toLocaleDateString("en-MY", { dateStyle: "full" })}`,
    "",
    "Copy and paste each section into the relevant platform.",
    border,
    "",
  ];

  for (const copy of copies) {
    lines.push(`PRODUCT: ${copy.productName}  (${copy.price})`);
    lines.push(divider);
    lines.push("");
    lines.push("📘 FACEBOOK:");
    lines.push(copy.facebook);
    lines.push("");
    lines.push("📸 INSTAGRAM:");
    lines.push(copy.instagram);
    lines.push("");
    lines.push("🎵 TIKTOK:");
    lines.push(copy.tiktok);
    lines.push("");
    lines.push("🛍️ SHOPEE LISTING REFRESH:");
    lines.push(copy.shopee);
    lines.push("");
    lines.push(border);
    lines.push("");
  }

  if (igResults.length > 0) {
    lines.push("INSTAGRAM AUTO-POST RESULTS");
    lines.push(divider);
    for (const r of igResults) {
      lines.push(r.ok ? `✅ ${r.name}` : `❌ ${r.name}: ${r.error ?? "unknown error"}`);
    }
    lines.push("");
    lines.push(border);
    lines.push("");
  }

  lines.push("— Sellabot Ad Pack Generator");
  return lines.join("\n");
}
