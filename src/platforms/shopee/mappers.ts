/**
 * Shopee raw JSON -> canonical domain models. This is the ONLY module that
 * knows Shopee field names. Defensive throughout: the live API adds/renames
 * fields, so every read tolerates missing data.
 */
import type {
  Address,
  Cancellation,
  Conversation,
  Dispute,
  Money,
  Order,
  OrderLineItem,
  OrderStatus,
  OrderSummary,
  PriceInfo,
  Product,
  ProductStatus,
  ProductVariant,
  ReturnRequest,
  ReturnStatus,
  Review,
  ShippingInfo,
  StockInfo,
  TrackingInfo,
  Voucher,
  VoucherStatus,
} from "../../core/models.js";
import type {
  RawComment,
  RawConversation,
  RawItem,
  RawModel,
  RawOrder,
  RawReturn,
  RawVoucher,
} from "./types.js";

function money(amount: number | undefined, currency: string): Money | null {
  if (amount == null) return null;
  return { amount, currency };
}

function isoFromUnix(sec?: number): string {
  return sec ? new Date(sec * 1000).toISOString() : new Date(0).toISOString();
}

function firstPrice(info?: { current_price?: number }[]): number | undefined {
  return info?.[0]?.current_price;
}

export function mapProductStatus(s?: string): ProductStatus {
  switch ((s ?? "").toUpperCase()) {
    case "NORMAL":
      return "live";
    case "UNLIST":
      return "unlisted";
    case "BANNED":
      return "banned";
    case "SELLER_DELETE":
    case "SHOPEE_DELETE":
      return "unlisted";
    default:
      return "unknown";
  }
}

export function mapModel(m: RawModel, currency: string): ProductVariant {
  return {
    variantId: String(m.model_id ?? ""),
    name: m.model_name ?? "",
    price: money(firstPrice(m.price_info), currency),
    stock: m.stock_info_v2?.summary_info?.total_available_stock ?? null,
  };
}

export function mapItem(
  item: RawItem,
  currency: string,
  models: RawModel[] = [],
): Product {
  return {
    productId: String(item.item_id ?? ""),
    name: item.item_name ?? "",
    description: item.description,
    status: mapProductStatus(item.item_status),
    price: money(firstPrice(item.price_info), currency),
    stock: item.stock_info_v2?.summary_info?.total_available_stock ?? null,
    sku: item.item_sku,
    categoryId: item.category_id != null ? String(item.category_id) : undefined,
    images: item.image?.image_url_list ?? [],
    variants: models.map((m) => mapModel(m, currency)),
  };
}

export function mapPriceInfo(
  item: RawItem,
  currency: string,
  models: RawModel[] = [],
): PriceInfo {
  return {
    productId: String(item.item_id ?? ""),
    price: money(firstPrice(item.price_info), currency),
    variants: models.map((m) => ({
      variantId: String(m.model_id ?? ""),
      name: m.model_name ?? "",
      price: money(firstPrice(m.price_info), currency),
    })),
  };
}

export function mapStockInfo(item: RawItem, models: RawModel[] = []): StockInfo {
  return {
    productId: String(item.item_id ?? ""),
    name: item.item_name ?? "",
    stock: item.stock_info_v2?.summary_info?.total_available_stock ?? null,
    variants: models.map((m) => ({
      variantId: String(m.model_id ?? ""),
      name: m.model_name ?? "",
      stock: m.stock_info_v2?.summary_info?.total_available_stock ?? null,
    })),
  };
}

export function mapOrderStatus(s?: string): OrderStatus {
  switch ((s ?? "").toUpperCase()) {
    case "UNPAID":
      return "unpaid";
    case "READY_TO_SHIP":
    case "PROCESSED":
    case "RETRY_SHIP":
      return "to_ship";
    case "SHIPPED":
    case "TO_CONFIRM_RECEIVE":
      return "shipped";
    case "COMPLETED":
      return "completed";
    case "CANCELLED":
    case "IN_CANCEL":
      return "cancelled";
    default:
      return "unknown";
  }
}

export function mapOrderSummary(o: RawOrder, currency: string): OrderSummary {
  return {
    orderId: o.order_sn ?? "",
    status: mapOrderStatus(o.order_status),
    total: money(o.total_amount, o.currency ?? currency),
    buyerName: o.buyer_username ?? "",
    createdAt: isoFromUnix(o.create_time),
  };
}

function mapAddress(a?: RawOrder["recipient_address"]): Address | null {
  if (!a) return null;
  return {
    name: a.name ?? "",
    phone: a.phone,
    line1: a.full_address ?? "",
    city: a.city,
    state: a.state,
    postalCode: a.zipcode,
    country: a.region,
  };
}

export function mapOrderDetail(o: RawOrder, currency: string): Order {
  const cur = o.currency ?? currency;
  const items: OrderLineItem[] = (o.item_list ?? []).map((it) => ({
    productId: String(it.item_id ?? ""),
    variantId: it.model_id != null ? String(it.model_id) : undefined,
    name: it.item_name ?? "",
    quantity: it.model_quantity_purchased ?? 0,
    price: money(it.model_discounted_price, cur),
  }));
  return {
    ...mapOrderSummary(o, currency),
    items,
    shipTo: mapAddress(o.recipient_address),
    shipByDeadline: o.ship_by_date ? isoFromUnix(o.ship_by_date) : undefined,
    trackingNumber: o.tracking_number,
  };
}

export function mapShippingInfo(
  orderId: string,
  param: Record<string, unknown>,
): ShippingInfo {
  const info = (param.info_needed ?? {}) as Record<string, unknown>;
  const pickup = (param.pickup ?? {}) as Record<string, unknown>;
  return {
    orderId,
    method: param.dropoff ? "dropoff" : param.pickup ? "pickup" : "unknown",
    notes: Object.keys(info).length
      ? `Required fields: ${Object.keys(info).join(", ")}`
      : undefined,
    pickupAddress: undefined,
    // address_list lives under pickup.address_list; left to the adapter to expand if needed
    ...(pickup.address_list ? {} : {}),
  };
}

export function mapTracking(orderId: string, raw: Record<string, unknown>): TrackingInfo {
  const list = (raw.tracking_info ?? []) as Array<Record<string, unknown>>;
  return {
    orderId,
    trackingNumber: (raw.tracking_number as string) ?? undefined,
    currentStatus: (list[list.length - 1]?.logistics_status as string) ?? "unknown",
    checkpoints: list.map((c) => ({
      status: (c.logistics_status as string) ?? "",
      description: (c.description as string) ?? undefined,
      timestamp: isoFromUnix(c.update_time as number | undefined),
    })),
  };
}

export function mapReturnStatus(s?: string): ReturnStatus {
  switch ((s ?? "").toUpperCase()) {
    case "REQUESTED":
    case "PROCESSING":
      return "pending";
    case "ACCEPTED":
    case "REFUND_PAID":
      return "accepted";
    case "REJECTED":
      return "rejected";
    case "CLOSED":
    case "CANCELLED":
      return "closed";
    default:
      return "unknown";
  }
}

export function mapReturn(r: RawReturn, currency: string): ReturnRequest {
  return {
    returnId: r.return_sn ?? "",
    orderId: r.order_sn ?? "",
    status: mapReturnStatus(r.status),
    reason: r.reason ?? "",
    requestedAmount: money(r.refund_amount, r.currency ?? currency),
    buyerName: r.user?.username ?? "",
    evidenceImages: r.image ?? [],
    createdAt: isoFromUnix(r.create_time),
  };
}

export function mapCancellationFromOrder(o: RawOrder): Cancellation {
  return {
    cancellationId: o.order_sn ?? "",
    orderId: o.order_sn ?? "",
    status: o.order_status ?? "",
    reason: "buyer_cancellation",
    buyerName: o.buyer_username ?? "",
    createdAt: isoFromUnix(o.create_time),
  };
}

export function mapDisputeFromReturn(r: RawReturn): Dispute {
  return {
    disputeId: r.return_sn ?? "",
    orderId: r.order_sn ?? "",
    status: r.status ?? "",
    reason: r.reason ?? "",
    buyerName: r.user?.username ?? "",
    createdAt: isoFromUnix(r.create_time),
  };
}

export function mapVoucherStatus(start?: number, end?: number): VoucherStatus {
  const now = Date.now() / 1000;
  if (start && now < start) return "upcoming";
  if (end && now > end) return "expired";
  if (start && end) return "ongoing";
  return "unknown";
}

export function mapVoucher(v: RawVoucher, currency: string): Voucher {
  const isPercent = (v.percentage ?? 0) > 0;
  return {
    voucherId: String(v.voucher_id ?? ""),
    name: v.voucher_name ?? "",
    status: mapVoucherStatus(v.start_time, v.end_time),
    discount: isPercent
      ? { type: "percent", value: v.percentage ?? 0, cap: v.max_price }
      : { type: "fixed", value: v.discount_amount ?? 0 },
    startAt: isoFromUnix(v.start_time),
    endAt: isoFromUnix(v.end_time),
    minSpend: v.min_basket_price != null ? { amount: v.min_basket_price, currency } : undefined,
    usageLimit: v.usage_quantity,
    scope: v.voucher_purpose === 1 ? "product" : "shop",
    productIds: v.item_id_list?.map(String),
  };
}

export function mapConversation(c: RawConversation): Conversation {
  return {
    conversationId: String(c.conversation_id ?? ""),
    buyerName: c.to_name ?? "",
    lastMessage: c.latest_message_content?.text ?? "",
    unread: (c.unread_count ?? 0) > 0,
    updatedAt: isoFromUnix(c.last_message_timestamp),
  };
}

export function mapReview(c: RawComment): Review {
  return {
    reviewId: String(c.comment_id ?? ""),
    productId: String(c.item_id ?? ""),
    rating: c.rating_star ?? 0,
    comment: c.comment ?? "",
    buyerName: c.buyer_username ?? "",
    replied: Boolean(c.comment_reply?.reply),
    createdAt: isoFromUnix(c.create_time),
  };
}
