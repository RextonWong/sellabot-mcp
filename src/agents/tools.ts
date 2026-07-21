/**
 * Tool definitions and implementations for the Manager Agent.
 * Each tool maps to one or more Platform adapter calls.
 * Grouped into two logical agents: Shopee and Marketing.
 */
import type { Platform } from "../core/platform.js";
import type { AuditLog } from "../core/audit.js";
import type { Config } from "../config.js";
import type { OrderStatus } from "../core/models.js";
import { runMorningBriefing } from "../routines/morning-briefing.js";
import { runEveningReport } from "../routines/evening-report.js";
import { loadState, saveState, formatMoney } from "../routines/shared.js";

// ── Tool schemas (sent to Claude) ─────────────────────────────────────────────

export const OPERATING_TOOL_DEFS = [
  // ── Operating Agent (day-to-day shop operations) ──
  {
    name: "get_orders",
    description: "Get orders from the shop. Use status='to_ship' for orders needing action, 'all' for everything recent.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["to_ship", "shipped", "completed", "cancelled", "unpaid", "all"],
          description: "Filter by order status. Default: to_ship",
        },
      },
    },
  },
  {
    name: "get_inventory",
    description: "Get stock levels for ALL live products — full inventory list. Use this when the seller wants to see all products and their stock. Use get_low_stock only for items specifically running low.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_low_stock",
    description: "List only products running low on stock (below threshold).",
    input_schema: {
      type: "object",
      properties: {
        threshold: { type: "number", description: "Max stock level to include. Default: configured LOW_STOCK_THRESHOLD." },
      },
    },
  },
  {
    name: "get_messages",
    description: "Get unread buyer messages / conversations.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_reviews",
    description: "Get recent product reviews.",
    input_schema: {
      type: "object",
      properties: {
        unreplied_only: { type: "boolean", description: "Only return reviews that haven't been replied to yet." },
      },
    },
  },
  {
    name: "get_returns",
    description: "Get pending return / refund requests from buyers.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_shop_performance",
    description: "Get shop KPIs: total sales, orders, rating, response rate.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["today", "7d", "30d"], description: "Time period. Default: 7d" },
      },
    },
  },
  {
    name: "run_briefing",
    description: "Run a full morning briefing: low stock, pending orders, messages, reviews, returns all in one summary.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "run_report",
    description: "Run the evening sales report.",
    input_schema: { type: "object", properties: {} },
  },

  // ── Listing creation ──
  {
    name: "upload_product_image",
    description: "Upload the product photo the seller just sent to Shopee's image hosting. Returns an image_id to include in create_listing. Call this FIRST when creating a new listing.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_categories",
    description: "Search Shopee product categories by keyword to find the right category_id for a new listing.",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Product type keyword, e.g. 'earphones', 'clothes', 'electronics', 'bag'" },
      },
      required: ["keyword"],
    },
  },
  {
    name: "draft_listing",
    description: "Show the seller a formatted preview of the listing before it goes live. Does NOT create anything. Always call this to get seller approval before create_listing.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Product name/title (concise, benefit-led)" },
        description: { type: "string", description: "Full product description with key features" },
        category_id: { type: "string", description: "Shopee category ID from search_categories" },
        category_path: { type: "string", description: "Human-readable category path for the preview" },
        price: { type: "number", description: "Price in MYR" },
        stock: { type: "number", description: "Initial stock quantity" },
        weight_kg: { type: "number", description: "Shipping weight in kg. Estimate from the product (e.g. a water dispenser ~12kg, a phone case ~0.1kg)." },
        length_cm: { type: "number", description: "Package length in cm. Estimate from product size." },
        width_cm: { type: "number", description: "Package width in cm. Estimate from product size." },
        height_cm: { type: "number", description: "Package height in cm. Estimate from product size." },
        brand: { type: "string", description: "Brand name (e.g. 'Cuckoo'). Use 'No Brand' if the product has no brand." },
        image_ids: {
          type: "array",
          items: { type: "string" },
          description: "Image IDs returned by upload_product_image",
        },
      },
      required: ["name", "description", "category_id", "price", "stock", "image_ids"],
    },
  },
  {
    name: "create_listing",
    description: "Post the product listing live on Shopee. Only call this AFTER the seller has explicitly said yes to the draft_listing preview. SENSITIVE — changes the live shop immediately.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        category_id: { type: "string" },
        price: { type: "number", description: "Price in MYR" },
        stock: { type: "number" },
        weight_kg: { type: "number" },
        length_cm: { type: "number" },
        width_cm: { type: "number" },
        height_cm: { type: "number" },
        brand: { type: "string", description: "Brand name. Use 'No Brand' if none." },
        image_ids: { type: "array", items: { type: "string" } },
      },
      required: ["name", "description", "category_id", "price", "stock", "image_ids"],
    },
  },

] as const;

// Promoting Agent — Shopee-native promotion tools (boost + vouchers)
export const PROMOTING_TOOL_DEFS = [
  {
    name: "list_products",
    description: "List the shop's live products with their IDs, price and stock — use this to decide which products to promote/boost.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many products to list. Default: 20" },
      },
    },
  },
  {
    name: "get_shop_performance",
    description: "Get shop KPIs (sales, orders, rating) to help decide what's worth promoting.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["today", "7d", "30d"], description: "Time period. Default: 7d" },
      },
    },
  },
  {
    name: "get_vouchers",
    description: "List existing shop vouchers (upcoming / ongoing / expired).",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["upcoming", "ongoing", "expired"], description: "Filter by status." },
      },
    },
  },
  {
    name: "boost_listing",
    description: "Boost a product to the top of Shopee search & category pages for a few hours (free — uses one of the 5 daily boost slots). ONLY call after the seller confirms. SENSITIVE.",
    input_schema: {
      type: "object",
      properties: {
        product_id: { type: "string", description: "The product ID to boost (from list_products)." },
        product_name: { type: "string", description: "The product name, for the confirmation message." },
      },
      required: ["product_id"],
    },
  },
  {
    name: "create_voucher",
    description: "Create a real Shopee discount voucher that buyers can claim. ONLY call after the seller confirms the exact terms. SENSITIVE — creates a live voucher.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Voucher display name, e.g. 'Weekend Deal'." },
        discount_percent: { type: "number", description: "Percentage off (1-90), e.g. 10 for 10% off. Use this OR discount_amount." },
        discount_amount: { type: "number", description: "Fixed RM off, e.g. 5 for RM5 off. Use this OR discount_percent." },
        duration_days: { type: "number", description: "How many days the voucher runs from now. Default: 7." },
        min_spend: { type: "number", description: "Minimum basket spend in RM to use the voucher. Optional." },
        usage_limit: { type: "number", description: "Max number of times the voucher can be used. Optional." },
        scope: { type: "string", enum: ["shop", "product"], description: "Shop-wide or specific products. Default: shop." },
        product_ids: { type: "array", items: { type: "string" }, description: "Product IDs when scope='product'." },
      },
      required: ["name", "duration_days"],
    },
  },
] as const;

// ── Tool implementations ───────────────────────────────────────────────────────

export interface ToolContext {
  pendingImageBase64?: string;
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  adapter: Platform,
  audit: AuditLog,
  config: Config,
  context: ToolContext = {},
): Promise<string> {
  const daemonCfg = config.daemon!;
  const tz = daemonCfg.timezone;

  switch (name) {
    case "get_orders": {
      const status = (input.status as string) ?? "to_ship";
      const page = await adapter.getOrders({
        status: status === "all" ? undefined : (status as OrderStatus),
        limit: 10,
      });
      if (page.items.length === 0) return "No orders found.";
      const lines = page.items.map(
        (o) => `#${o.orderId} — ${o.buyerName} — ${formatMoney(o.total)} — ${o.status}`,
      );
      return `${page.items.length} order(s):\n${lines.join("\n")}`;
    }

    case "get_inventory": {
      const allProducts = [];
      let cursor: string | undefined;
      do {
        const page = await adapter.getProducts({ status: "live", limit: 50, cursor });
        allProducts.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor && allProducts.length < 200);

      if (allProducts.length === 0) return "No live products found.";
      const lines = allProducts.map((p) => {
        const stock = p.stock ?? 0;
        const flag = stock === 0 ? " ❌ OUT OF STOCK" : stock <= 5 ? " ⚠️ LOW" : "";
        return `${p.name}: ${stock}${flag}`;
      });
      return `Inventory — ${allProducts.length} product(s):\n${lines.join("\n")}`;
    }

    case "get_low_stock": {
      const threshold = (input.threshold as number) ?? daemonCfg.lowStockThreshold;
      const page = await adapter.getLowStockItems({ threshold, limit: 20 });
      if (page.items.length === 0) return "All products have sufficient stock.";
      const lines = page.items.map((s) => `${s.name}: ${s.stock ?? 0} left`);
      return `${page.items.length} low-stock item(s):\n${lines.join("\n")}`;
    }

    case "get_messages": {
      const page = await adapter.getMessages({ status: "unread", limit: 10 });
      if (page.items.length === 0) return "No unread messages.";
      const lines = page.items.map((m) => `${m.buyerName}: "${m.lastMessage.slice(0, 100)}"`);
      return `${page.items.length} unread message(s):\n${lines.join("\n")}`;
    }

    case "get_reviews": {
      const unreplied = input.unreplied_only as boolean | undefined;
      const page = await adapter.getReviews({
        replied: unreplied ? false : undefined,
        limit: 10,
      });
      if (page.items.length === 0) return "No reviews found.";
      const lines = page.items.map(
        (r) => `⭐${r.rating} ${r.buyerName}: "${r.comment.slice(0, 80)}" ${r.replied ? "(replied)" : "(no reply yet)"}`,
      );
      return `${page.items.length} review(s):\n${lines.join("\n")}`;
    }

    case "get_returns": {
      const page = await adapter.getReturns({ status: "pending", limit: 10 });
      if (page.items.length === 0) return "No pending return requests.";
      const lines = page.items.map(
        (r) => `Return #${r.returnId} (Order #${r.orderId}) — ${r.buyerName} — ${r.reason} — ${formatMoney(r.requestedAmount)}`,
      );
      return `${page.items.length} pending return(s):\n${lines.join("\n")}`;
    }

    case "get_shop_performance": {
      const period = (input.period as "today" | "7d" | "30d") ?? "7d";
      const perf = await adapter.getShopPerformance({ period });
      const lines = [
        `Period: ${perf.period}`,
        perf.sales ? `Sales: ${formatMoney(perf.sales)}` : null,
        perf.orders != null ? `Orders: ${perf.orders}` : null,
        perf.rating != null ? `Rating: ${perf.rating.toFixed(1)}/5` : null,
        perf.responseRate != null ? `Response rate: ${(perf.responseRate * 100).toFixed(0)}%` : null,
        perf.penaltyPoints != null ? `Penalty points: ${perf.penaltyPoints}` : null,
      ].filter(Boolean);
      return lines.join("\n");
    }

    case "run_briefing": {
      const state = loadState();
      const { result, updatedState } = await runMorningBriefing(
        adapter,
        state.morningBriefing,
        tz,
        {
          lowStockThreshold: daemonCfg.lowStockThreshold,
          autoReplyReviews: false,
          autoAcceptUnpaidCancellations: false,
          restockAlertDays: daemonCfg.restockAlertDays,
        },
        audit,
      );
      state.morningBriefing = updatedState;
      saveState(state);
      return result.summary;
    }

    case "run_report": {
      const state = loadState();
      const { result, updatedState } = await runEveningReport(adapter, state.eveningReport, tz);
      state.eveningReport = updatedState;
      saveState(state);
      return result.summary;
    }

    // ── Promoting Agent tools ──
    case "list_products": {
      const limit = (input.limit as number) ?? 20;
      const page = await adapter.getProducts({ status: "live", limit });
      if (page.items.length === 0) return "No live products found.";
      const lines = page.items.map(
        (p) => `ID ${p.productId} — ${p.name} — ${formatMoney(p.price)} — stock ${p.stock ?? 0}`,
      );
      return `${page.items.length} live product(s):\n${lines.join("\n")}`;
    }

    case "get_vouchers": {
      const status = input.status as "upcoming" | "ongoing" | "expired" | undefined;
      const page = await adapter.getVouchers({ status, limit: 20 });
      if (page.items.length === 0) return "No vouchers found.";
      const lines = page.items.map((v) => {
        const d = v.discount.type === "percent" ? `${v.discount.value}% off` : `RM${v.discount.value} off`;
        return `${v.name} — ${d} — ${v.status}`;
      });
      return `${page.items.length} voucher(s):\n${lines.join("\n")}`;
    }

    case "boost_listing": {
      const productId = input.product_id as string;
      const productName = (input.product_name as string) ?? productId;
      await adapter.boostListing({ productId });
      audit.record({
        tool: "boost_listing",
        tier: "SENSITIVE",
        effect: `Boosted product ${productId} (${productName}) to top of Shopee search`,
        decision: "approved",
        outcome: "executed",
      });
      return `Boosted "${productName}" — it's now bumped to the top of Shopee search & category pages for the next few hours.`;
    }

    case "create_voucher": {
      const name = input.name as string;
      const days = (input.duration_days as number) ?? 7;
      const pct = input.discount_percent as number | undefined;
      const amt = input.discount_amount as number | undefined;
      const scope = ((input.scope as string) ?? "shop") as "shop" | "product";
      const productIds = input.product_ids as string[] | undefined;
      const minSpend = input.min_spend as number | undefined;
      const usageLimit = input.usage_limit as number | undefined;

      if (pct == null && amt == null) {
        return "Please specify either a percentage (discount_percent) or a fixed amount (discount_amount) for the voucher.";
      }
      const discount =
        pct != null
          ? { type: "percent" as const, value: pct }
          : { type: "fixed" as const, value: amt! };

      const startAt = new Date().toISOString();
      const endAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      const voucher = await adapter.createVoucher({
        name,
        discount,
        startAt,
        endAt,
        minSpend: minSpend != null ? { amount: minSpend, currency: "MYR" } : undefined,
        usageLimit,
        scope,
        productIds: scope === "product" ? productIds : undefined,
      });
      audit.record({
        tool: "create_voucher",
        tier: "SENSITIVE",
        effect: `Created voucher "${name}" (${pct != null ? `${pct}%` : `RM${amt}`} off, ${days} days)`,
        decision: "approved",
        outcome: "executed",
      });
      const disc = pct != null ? `${pct}% off` : `RM${amt} off`;
      return `Voucher created! "${voucher.name}" — ${disc}, valid ${days} days${minSpend ? `, min spend RM${minSpend}` : ""}. Buyers can now claim it.`;
    }

    case "upload_product_image": {
      const img = context.pendingImageBase64;
      if (!img) return "No product image is pending. Please send a photo first.";
      if (!adapter.uploadImage) return "Image upload is not supported on this platform.";
      const imageId = await adapter.uploadImage(img);
      return `Image uploaded. image_id: ${imageId}`;
    }

    case "search_categories": {
      const keyword = input.keyword as string;
      if (!adapter.searchCategories) return "Category search is not supported on this platform.";
      const cats = await adapter.searchCategories(keyword);
      if (cats.length === 0) return `No Shopee categories found for "${keyword}". Try a broader keyword (e.g. "electronics", "fashion", "health").`;
      const lines = cats.map((c) => `ID ${c.id}: ${c.path}`);
      return `Shopee categories matching "${keyword}":\n${lines.join("\n")}`;
    }

    case "draft_listing": {
      const p = input as {
        name: string; description: string; category_id: string; category_path?: string;
        price: number; stock: number; weight_kg?: number; brand?: string;
        length_cm?: number; width_cm?: number; height_cm?: number; image_ids: string[];
      };
      const dims =
        p.length_cm && p.width_cm && p.height_cm
          ? `${p.length_cm} x ${p.width_cm} x ${p.height_cm} cm`
          : "20 x 20 x 20 cm (default)";
      const lines = [
        "=== LISTING PREVIEW ===",
        `Name: ${p.name}`,
        `Brand: ${p.brand || "No Brand"}`,
        `Category: ${p.category_path ?? `ID ${p.category_id}`}`,
        `Price: RM${p.price.toFixed(2)}`,
        `Stock: ${p.stock} unit(s)`,
        `Weight: ${p.weight_kg ? `${p.weight_kg} kg` : "0.5 kg (default)"}`,
        `Parcel size: ${dims}`,
        `Images: ${p.image_ids.length} uploaded`,
        "",
        "Description:",
        p.description,
        "",
        "========================",
        'Reply "yes post it" to publish, or tell me what to change.',
      ];
      return lines.join("\n");
    }

    case "create_listing": {
      const p = input as {
        name: string; description: string; category_id: string;
        price: number; stock: number; weight_kg?: number; brand?: string;
        length_cm?: number; width_cm?: number; height_cm?: number; image_ids: string[];
      };
      const currency = daemonCfg.notifyEmail ? "MYR" : "MYR"; // shop is MY
      const dimensions =
        p.length_cm && p.width_cm && p.height_cm
          ? { lengthCm: p.length_cm, widthCm: p.width_cm, heightCm: p.height_cm }
          : undefined;
      const product = await adapter.createListing({
        name: p.name,
        description: p.description,
        categoryId: p.category_id,
        price: { amount: p.price, currency },
        stock: p.stock,
        images: p.image_ids,
        weightKg: p.weight_kg,
        brand: { name: p.brand || "No Brand" },
        dimensions,
      });
      audit.record({
        tool: "create_listing",
        tier: "SENSITIVE",
        effect: `Created listing "${p.name}" at RM${p.price.toFixed(2)} with ${p.stock} stock`,
        decision: "approved",
        outcome: "executed",
      });
      return `Listing posted! Product ID: ${product.productId} — "${product.name}" is now live on Shopee.`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
