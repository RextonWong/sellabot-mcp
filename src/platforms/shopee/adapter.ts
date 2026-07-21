/**
 * Shopee adapter — implements the canonical `Platform` contract by composing
 * the signed client with the mappers. No tool ever imports this directly; the
 * registry hands it out behind the `Platform` interface.
 *
 * Where Shopee needs several calls to assemble one canonical object (e.g. item
 * base info + model list), that stitching happens here.
 */
import { NotFoundError, UnsupportedOperationError } from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import type {
  BulkResult,
  Cancellation,
  Conversation,
  Dispute,
  DocumentRef,
  Order,
  OrderSummary,
  Page,
  PageParams,
  PlatformName,
  PriceInfo,
  Product,
  ReturnRequest,
  Review,
  ShipmentResult,
  ShippingInfo,
  ShopInfo,
  ShopPerformance,
  StockInfo,
  TrackingInfo,
  Voucher,
} from "../../core/models.js";
import type {
  ArrangeShipmentParams,
  BoostParams,
  BulkPriceParams,
  Capability,
  CreateListingParams,
  CreateVoucherParams,
  DeleteListingParams,
  GetCancellationsParams,
  GetDisputesParams,
  GetMessagesParams,
  GetOrdersParams,
  GetProductsParams,
  GetReturnsParams,
  GetReviewsParams,
  GetVouchersParams,
  PerformanceParams,
  Platform,
  ReplyMessageParams,
  ReplyReviewParams,
  RespondToCancellationParams,
  RespondToDisputeParams,
  RespondToReturnParams,
  ShippingDocumentParams,
  TrackShipmentParams,
  UpdateListingParams,
  UpdatePriceParams,
  UpdateStockParams,
} from "../../core/platform.js";
import type { ShopeeClient } from "./client.js";
import { PATHS } from "./endpoints.js";
import * as map from "./mappers.js";
import type { RawItem, RawModel, RawOrder, RawReturn, RawVoucher } from "./types.js";

const CAPABILITIES: Capability[] = [
  "products",
  "pricing",
  "inventory",
  "customer_service",
  "reviews",
  "orders",
  "fulfillment",
  "returns",
  "disputes",
  "vouchers",
  "boost",
  "performance",
];

/** Shopee get_order_list requires a bounded time window (<= 15 days). */
const FIFTEEN_DAYS_SEC = 15 * 24 * 60 * 60;

export class ShopeeAdapter implements Platform {
  readonly name: PlatformName = "shopee";
  readonly capabilities: ReadonlySet<Capability> = new Set(CAPABILITIES);

  constructor(
    private client: ShopeeClient,
    private currency: string,
  ) {}

  // ── helpers ───────────────────────────────────────────────────────────--

  private async itemBaseInfo(itemIds: string[]): Promise<RawItem[]> {
    if (itemIds.length === 0) return [];
    const res = await this.client.call<{ item_list?: RawItem[] }>(
      PATHS.productGetItemBaseInfo,
      { query: { item_id_list: itemIds.join(",") } },
    );
    return res.item_list ?? [];
  }

  private async modelList(itemId: string): Promise<RawModel[]> {
    const res = await this.client.call<{ model?: RawModel[] }>(PATHS.productGetModelList, {
      query: { item_id: itemId },
    });
    return res.model ?? [];
  }

  // ── products ──────────────────────────────────────────────────────────--

  async getProducts(p: GetProductsParams): Promise<Page<Product>> {
    const offset = p.cursor ? Number(p.cursor) : 0;
    const pageSize = p.limit ?? 50;
    const statusMap: Record<string, string> = {
      live: "NORMAL",
      unlisted: "UNLIST",
      banned: "BANNED",
      sold_out: "NORMAL",
    };
    const list = await this.client.call<{
      item?: { item_id: number }[];
      has_next_page?: boolean;
      next_offset?: number;
    }>(PATHS.productGetItemList, {
      query: {
        offset,
        page_size: pageSize,
        item_status: p.status ? statusMap[p.status] : "NORMAL",
      },
    });
    const ids = (list.item ?? []).map((i) => String(i.item_id));
    const items = await this.itemBaseInfo(ids);
    return {
      items: items.map((it) => map.mapItem(it, this.currency)),
      nextCursor: list.has_next_page ? String(list.next_offset ?? offset + pageSize) : null,
    };
  }

  async createListing(p: CreateListingParams): Promise<Product> {
    // Auto-fetch enabled logistics channels — Shopee requires at least one
    const chRes = await this.client.call<{
      logistics_channel_list?: Array<{ logistic_id: number; enabled: boolean }>;
    }>(PATHS.logisticsGetChannelList);
    const logisticsList = (chRes.logistics_channel_list ?? [])
      .filter((c) => c.enabled)
      .map((c) => ({ logistic_id: c.logistic_id, enabled: true }));

    const res = await this.client.call<{ item_id?: number }>(PATHS.productAddItem, {
      method: "POST",
      body: {
        item_name: p.name,
        description: p.description,
        category_id: Number(p.categoryId),
        original_price: p.price.amount,
        seller_stock: [{ stock: p.stock }],
        image: { image_id_list: p.images },
        weight: p.weightKg ?? 0.5,
        item_status: "NORMAL",
        logistics: logisticsList,
        dimension: p.dimensions
          ? {
              package_length: p.dimensions.lengthCm,
              package_width: p.dimensions.widthCm,
              package_height: p.dimensions.heightCm,
            }
          : undefined,
        ...(p.attributes ?? {}),
      },
    });
    const itemId = String(res.item_id ?? "");
    const [item] = await this.itemBaseInfo([itemId]);
    if (!item) throw new NotFoundError(`Created item ${itemId} could not be re-read.`);
    return map.mapItem(item, this.currency);
  }

  async uploadImage(imageBase64: string): Promise<string> {
    const buffer = Buffer.from(imageBase64, "base64");
    return this.client.uploadImageBuffer(buffer, "image/jpeg");
  }

  async searchCategories(keyword: string): Promise<Array<{ id: string; name: string; path: string }>> {
    const res = await this.client.call<{
      category_list?: Array<Record<string, unknown>>;
    }>(PATHS.productGetCategory, { query: { language: "en" } });

    const raw = res.category_list ?? [];

    // Log the first entry so we can see the actual field names Shopee uses
    if (raw.length > 0) {
      logger.info("shopee category sample", { first: JSON.stringify(raw[0]).slice(0, 300) });
    }

    // Shopee may use category_name or display_category_name depending on region/version
    const getName = (c: Record<string, unknown>): string =>
      (c.display_category_name as string) ||
      (c.category_name as string) ||
      (c.category_name_en as string) ||
      "";

    const all = raw.map((c) => ({
      category_id: c.category_id as number,
      parent_category_id: c.parent_category_id as number,
      has_children: c.has_children as boolean,
      name: getName(c),
    }));

    if (all.length === 0) {
      return [{ id: "0", name: "No categories (API returned empty list)", path: "Specify category_id manually" }];
    }

    const nameMap = new Map(all.map((c) => [c.category_id, c.name]));
    const kw = keyword.toLowerCase();

    const toEntry = (c: { category_id: number; parent_category_id: number; name: string }) => {
      const parent = c.parent_category_id !== 0 ? nameMap.get(c.parent_category_id) : undefined;
      return {
        id: String(c.category_id),
        name: c.name,
        path: parent ? `${parent} > ${c.name}` : c.name,
      };
    };

    // Only leaf categories — Shopee rejects parent categories on add_item
    const leaves = all.filter((c) => !c.has_children);

    const matched = leaves.filter((c) => {
      const name = c.name.toLowerCase();
      const parentName = (nameMap.get(c.parent_category_id) ?? "").toLowerCase();
      return name.includes(kw) || parentName.includes(kw);
    });

    if (matched.length > 0) return matched.slice(0, 12).map(toEntry);

    // No keyword match — return first 15 leaf categories for Claude to pick
    return leaves.slice(0, 15).map((c) => ({
      ...toEntry(c),
      name: c.name || `Category ${c.category_id}`,
    }));
  }

  async updateListing(p: UpdateListingParams): Promise<Product> {
    await this.client.call(PATHS.productUpdateItem, {
      method: "POST",
      body: {
        item_id: Number(p.productId),
        ...(p.name ? { item_name: p.name } : {}),
        ...(p.description ? { description: p.description } : {}),
        ...(p.categoryId ? { category_id: Number(p.categoryId) } : {}),
        ...(p.images ? { image: { image_id_list: p.images } } : {}),
        ...(p.weightKg ? { weight: p.weightKg } : {}),
        ...(p.attributes ?? {}),
      },
    });
    const [item] = await this.itemBaseInfo([p.productId]);
    if (!item) throw new NotFoundError(`Item ${p.productId} not found.`);
    return map.mapItem(item, this.currency);
  }

  async deleteListing(p: DeleteListingParams): Promise<void> {
    if (p.mode === "unlist") {
      await this.client.call(PATHS.productUnlistItem, {
        method: "POST",
        body: { item_list: [{ item_id: Number(p.productId), unlist: true }] },
      });
    } else {
      await this.client.call(PATHS.productDeleteItem, {
        method: "POST",
        body: { item_id: Number(p.productId) },
      });
    }
  }

  // ── pricing ───────────────────────────────────────────────────────────--

  async getPrice(p: { productId: string }): Promise<PriceInfo> {
    const [item] = await this.itemBaseInfo([p.productId]);
    if (!item) throw new NotFoundError(`Item ${p.productId} not found.`);
    const models = item.has_model ? await this.modelList(p.productId) : [];
    return map.mapPriceInfo(item, this.currency, models);
  }

  async updatePrice(p: UpdatePriceParams): Promise<void> {
    await this.client.call(PATHS.productUpdatePrice, {
      method: "POST",
      body: {
        item_id: Number(p.productId),
        price_list: [
          {
            model_id: p.variantId ? Number(p.variantId) : 0,
            original_price: p.price.amount,
          },
        ],
      },
    });
  }

  async bulkUpdatePrice(p: BulkPriceParams): Promise<BulkResult> {
    const results = [];
    let succeeded = 0;
    let failed = 0;
    for (const u of p.updates) {
      try {
        await this.updatePrice(u);
        succeeded++;
        results.push({ productId: u.productId, variantId: u.variantId, ok: true });
      } catch (err) {
        failed++;
        results.push({
          productId: u.productId,
          variantId: u.variantId,
          ok: false,
          error: (err as Error).message,
        });
      }
    }
    return { succeeded, failed, results };
  }

  // ── inventory ─────────────────────────────────────────────────────────--

  async getStock(p: { productId: string }): Promise<StockInfo> {
    const [item] = await this.itemBaseInfo([p.productId]);
    if (!item) throw new NotFoundError(`Item ${p.productId} not found.`);
    const models = item.has_model ? await this.modelList(p.productId) : [];
    return map.mapStockInfo(item, models);
  }

  async updateStock(p: UpdateStockParams): Promise<void> {
    await this.client.call(PATHS.productUpdateStock, {
      method: "POST",
      body: {
        item_id: Number(p.productId),
        stock_list: [
          {
            model_id: p.variantId ? Number(p.variantId) : 0,
            seller_stock: [{ stock: p.stock }],
          },
        ],
      },
    });
  }

  async getLowStockItems(
    p: { threshold: number } & PageParams,
  ): Promise<Page<StockInfo>> {
    const page = await this.getProducts({ limit: p.limit, cursor: p.cursor });
    const low = page.items
      .filter((it) => it.stock != null && it.stock <= p.threshold)
      .map<StockInfo>((it) => ({
        productId: it.productId,
        name: it.name,
        stock: it.stock,
        variants: it.variants.map((v) => ({
          variantId: v.variantId,
          name: v.name,
          stock: v.stock,
        })),
      }));
    return { items: low, nextCursor: page.nextCursor };
  }

  // ── customer service ────────────────────────────────────────────────---

  async getMessages(p: GetMessagesParams): Promise<Page<Conversation>> {
    const res = await this.client.call<{ conversations?: RawConversationRaw[] }>(
      PATHS.chatGetConversationList,
      {
        method: "POST",
        body: {
          direction: "latest",
          type: p.status === "unread" ? "unread" : "all",
          page_size: p.limit ?? 50,
        },
      },
    );
    const list = (res.conversations ?? []) as RawConversationRaw[];
    return {
      items: list.map(map.mapConversation),
      nextCursor: null,
    };
  }

  async replyToMessage(p: ReplyMessageParams): Promise<void> {
    await this.client.call(PATHS.chatSendMessage, {
      method: "POST",
      body: {
        conversation_id: p.conversationId,
        message_type: "text",
        content: { text: p.text },
      },
    });
  }

  async getReviews(p: GetReviewsParams): Promise<Page<Review>> {
    const res = await this.client.call<{ item_comment_list?: RawCommentRaw[]; more?: boolean }>(
      PATHS.commentGetList,
      {
        query: {
          item_id: p.productId ? Number(p.productId) : undefined,
          cursor: p.cursor,
          page_size: p.limit ?? 50,
        },
      },
    );
    let items = (res.item_comment_list ?? []).map(map.mapReview);
    if (p.rating != null) items = items.filter((r) => r.rating === p.rating);
    if (p.replied != null) items = items.filter((r) => r.replied === p.replied);
    return { items, nextCursor: null };
  }

  async replyToReview(p: ReplyReviewParams): Promise<void> {
    await this.client.call(PATHS.commentReply, {
      method: "POST",
      body: { comment_list: [{ comment_id: Number(p.reviewId), comment: p.text }] },
    });
  }

  // ── orders & fulfillment ────────────────────────────────────────────---

  async getOrders(p: GetOrdersParams): Promise<Page<OrderSummary>> {
    const now = Math.floor(Date.now() / 1000);

    // to_ship maps to TWO Shopee statuses — query both and merge
    const singleStatusMap: Record<string, string> = {
      unpaid: "UNPAID",
      shipped: "SHIPPED",
      completed: "COMPLETED",
      cancelled: "CANCELLED",
    };
    const shopeeStatuses: Array<string | undefined> =
      p.status === "to_ship"
        ? ["READY_TO_SHIP", "PROCESSED"]
        : [p.status ? singleStatusMap[p.status] : undefined];

    const allSns = new Set<string>();
    for (const orderStatus of shopeeStatuses) {
      const list = await this.client.call<{
        order_list?: { order_sn: string }[];
        next_cursor?: string;
        more?: boolean;
      }>(PATHS.orderGetList, {
        query: {
          time_range_field: "create_time",
          time_from: now - FIFTEEN_DAYS_SEC,
          time_to: now,
          page_size: p.limit ?? 50,
          cursor: p.cursor,
          order_status: orderStatus,
        },
      });
      for (const o of list.order_list ?? []) allSns.add(o.order_sn);
    }

    const details = await this.orderDetails([...allSns].slice(0, p.limit ?? 50));
    return {
      items: details.map((o) => map.mapOrderSummary(o, this.currency)),
      nextCursor: null,
    };
  }

  private async orderDetails(orderSns: string[]): Promise<RawOrder[]> {
    if (orderSns.length === 0) return [];
    const res = await this.client.call<{ order_list?: RawOrder[] }>(PATHS.orderGetDetail, {
      query: {
        order_sn_list: orderSns.join(","),
        response_optional_fields:
          "buyer_username,recipient_address,item_list,total_amount,ship_by_date,tracking_number",
      },
    });
    return res.order_list ?? [];
  }

  async getOrder(p: { orderId: string }): Promise<Order> {
    const [o] = await this.orderDetails([p.orderId]);
    if (!o) throw new NotFoundError(`Order ${p.orderId} not found.`);
    return map.mapOrderDetail(o, this.currency);
  }

  async getShippingInfo(p: { orderId: string }): Promise<ShippingInfo> {
    const res = await this.client.call<Record<string, unknown>>(
      PATHS.logisticsGetShippingParameter,
      { query: { order_sn: p.orderId } },
    );
    return map.mapShippingInfo(p.orderId, res);
  }

  async trackShipment(p: TrackShipmentParams): Promise<TrackingInfo> {
    if (!p.orderId) {
      throw new NotFoundError("Shopee tracking requires an order_id.");
    }
    const res = await this.client.call<Record<string, unknown>>(
      PATHS.logisticsGetTrackingInfo,
      { query: { order_sn: p.orderId } },
    );
    return map.mapTracking(p.orderId, res);
  }

  async arrangeShipment(p: ArrangeShipmentParams): Promise<ShipmentResult> {
    await this.client.call(PATHS.logisticsShipOrder, {
      method: "POST",
      body: {
        order_sn: p.orderId,
        ...(p.method === "pickup"
          ? { pickup: { address_id: 0, pickup_time_id: p.pickupTime } }
          : { dropoff: {} }),
      },
    });
    return { orderId: p.orderId, method: p.method };
  }

  async getShippingDocument(p: ShippingDocumentParams): Promise<DocumentRef> {
    await this.client.call(PATHS.logisticsCreateShippingDocument, {
      method: "POST",
      body: { order_list: [{ order_sn: p.orderId }] },
    });
    // The binary download is fetched separately; we return a reference the
    // caller can act on. (Binary streaming is out of scope for the JSON client.)
    return {
      orderId: p.orderId,
      format: p.format ?? "pdf",
      document: `${PATHS.logisticsDownloadShippingDocument}?order_sn=${p.orderId}`,
      encoding: "url",
    };
  }

  // ── returns, cancellations & disputes ──────────────────────────────────

  async getReturns(p: GetReturnsParams): Promise<Page<ReturnRequest>> {
    const res = await this.client.call<{ return?: RawReturn[]; more?: boolean }>(
      PATHS.returnsGetList,
      { query: { page_no: p.cursor ? Number(p.cursor) : 0, page_size: p.limit ?? 50 } },
    );
    return {
      items: (res.return ?? []).map((r) => map.mapReturn(r, this.currency)),
      nextCursor: null,
    };
  }

  async getReturn(p: { returnId: string }): Promise<ReturnRequest> {
    const res = await this.client.call<RawReturn>(PATHS.returnsGetDetail, {
      query: { return_sn: p.returnId },
    });
    if (!res?.return_sn) throw new NotFoundError(`Return ${p.returnId} not found.`);
    return map.mapReturn(res, this.currency);
  }

  async respondToReturn(p: RespondToReturnParams): Promise<void> {
    if (p.decision === "accept") {
      await this.client.call(PATHS.returnsConfirm, {
        method: "POST",
        body: { return_sn: p.returnId },
      });
    } else {
      await this.client.call(PATHS.returnsDispute, {
        method: "POST",
        body: { return_sn: p.returnId, ...(p.reason ? { reason: p.reason } : {}) },
      });
    }
  }

  async getCancellations(p: GetCancellationsParams): Promise<Page<Cancellation>> {
    const page = await this.getOrders({ status: "cancelled", limit: p.limit, cursor: p.cursor });
    const details = await this.orderDetails(page.items.map((o) => o.orderId));
    return {
      items: details.map(map.mapCancellationFromOrder),
      nextCursor: page.nextCursor,
    };
  }

  async respondToCancellation(p: RespondToCancellationParams): Promise<void> {
    await this.client.call(PATHS.orderHandleBuyerCancellation, {
      method: "POST",
      body: {
        order_sn: p.cancellationId,
        operation: p.decision === "accept" ? "ACCEPT" : "REJECT",
      },
    });
  }

  async getDisputes(p: GetDisputesParams): Promise<Page<Dispute>> {
    // Shopee surfaces disputes through the returns flow; map disputed returns.
    const res = await this.client.call<{ return?: RawReturn[] }>(PATHS.returnsGetList, {
      query: { page_no: p.cursor ? Number(p.cursor) : 0, page_size: p.limit ?? 50 },
    });
    return {
      items: (res.return ?? []).map(map.mapDisputeFromReturn),
      nextCursor: null,
    };
  }

  async respondToDispute(p: RespondToDisputeParams): Promise<void> {
    await this.client.call(PATHS.returnsDispute, {
      method: "POST",
      body: {
        return_sn: p.disputeId,
        reason: p.proposedResolution ?? p.message,
        ...(p.evidence ? { evidence: p.evidence } : {}),
      },
    });
  }

  // ── promotions ────────────────────────────────────────────────────────--

  async getVouchers(p: GetVouchersParams): Promise<Page<Voucher>> {
    const statusMap: Record<string, string> = {
      upcoming: "upcoming",
      ongoing: "ongoing",
      expired: "expired",
    };
    const res = await this.client.call<{ voucher_list?: RawVoucher[]; more?: boolean }>(
      PATHS.voucherGetList,
      {
        query: {
          status: p.status ? statusMap[p.status] : "all",
          page_no: p.cursor ? Number(p.cursor) : 1,
          page_size: p.limit ?? 50,
        },
      },
    );
    return {
      items: (res.voucher_list ?? []).map((v) => map.mapVoucher(v, this.currency)),
      nextCursor: null,
    };
  }

  async createVoucher(p: CreateVoucherParams): Promise<Voucher> {
    const res = await this.client.call<{ voucher_id?: number }>(PATHS.voucherAdd, {
      method: "POST",
      body: {
        voucher_name: p.name,
        voucher_type: p.scope === "product" ? 1 : 0,
        reward_type: p.discount.type === "percent" ? 2 : 1,
        discount_amount: p.discount.type === "fixed" ? p.discount.value : undefined,
        percentage: p.discount.type === "percent" ? p.discount.value : undefined,
        max_price: p.discount.cap,
        min_basket_price: p.minSpend?.amount,
        usage_quantity: p.usageLimit,
        start_time: Math.floor(new Date(p.startAt).getTime() / 1000),
        end_time: Math.floor(new Date(p.endAt).getTime() / 1000),
        item_id_list: p.productIds?.map(Number),
      },
    });
    return {
      voucherId: String(res.voucher_id ?? ""),
      name: p.name,
      status: "upcoming",
      discount: p.discount,
      startAt: p.startAt,
      endAt: p.endAt,
      minSpend: p.minSpend,
      usageLimit: p.usageLimit,
      scope: p.scope,
      productIds: p.productIds,
    };
  }

  async boostListing(p: BoostParams): Promise<void> {
    await this.client.call(PATHS.productBoostItem, {
      method: "POST",
      body: { item_id_list: [Number(p.productId)] },
    });
  }

  // ── shop ──────────────────────────────────────────────────────────────--

  async getShopInfo(): Promise<ShopInfo> {
    const info = await this.client.call<{
      shop_name?: string;
      region?: string;
      status?: string;
      shop_id?: number;
    }>(PATHS.shopGetInfo);
    return {
      // Shopee's get_shop_info body omits shop_id; fall back to the authorized shop.
      shopId: info.shop_id ? String(info.shop_id) : this.client.shopId,
      name: info.shop_name ?? "",
      region: info.region ?? "",
      status: info.status ?? "",
      authHealthy: true, // reaching this call at all means the token is valid
    };
  }

  async getShopPerformance(p: PerformanceParams): Promise<ShopPerformance> {
    const res = await this.client.call<Record<string, unknown>>(PATHS.shopPerformance);
    const metrics: Record<string, number | string> = {};
    for (const [k, v] of Object.entries(res)) {
      if (typeof v === "number" || typeof v === "string") metrics[k] = v;
    }
    return { period: p.period ?? "30d", metrics };
  }
}

// Local aliases to keep mapper signatures honest without widening types.ts.
type RawConversationRaw = Parameters<typeof map.mapConversation>[0];
type RawCommentRaw = Parameters<typeof map.mapReview>[0];
