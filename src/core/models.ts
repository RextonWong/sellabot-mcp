/**
 * Canonical domain models.
 *
 * These are the platform-agnostic shapes that tools speak. Every adapter's
 * `mappers.ts` is the ONLY place allowed to translate between a marketplace's
 * native JSON and these types. Tools, the registry, and the consent layer
 * never see Shopee/Lazada/TikTok field names.
 */

export type PlatformName = "shopee" | "lazada" | "tiktok";

/** Money is always explicit about currency. `amount` is in major units (e.g. 24.90 RM). */
export interface Money {
  amount: number;
  currency: string;
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page, or null when there are no more results. */
  nextCursor: string | null;
}

export interface PageParams {
  limit?: number;
  cursor?: string;
}

// ── Products ────────────────────────────────────────────────────────────────

export type ProductStatus = "live" | "unlisted" | "banned" | "sold_out" | "unknown";

export interface ProductVariant {
  variantId: string;
  name: string;
  price: Money | null;
  stock: number | null;
  sku?: string;
}

export interface Product {
  productId: string;
  name: string;
  description?: string;
  status: ProductStatus;
  price: Money | null;
  stock: number | null;
  sku?: string;
  categoryId?: string;
  images: string[];
  variants: ProductVariant[];
}

export interface Dimensions {
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

// ── Pricing ───────────────────────────────────────────────────────────────--

export interface PriceInfo {
  productId: string;
  price: Money | null;
  variants: Array<{ variantId: string; name: string; price: Money | null }>;
}

export interface BulkResultItem {
  productId: string;
  variantId?: string;
  ok: boolean;
  error?: string;
}

export interface BulkResult {
  succeeded: number;
  failed: number;
  results: BulkResultItem[];
}

// ── Inventory ─────────────────────────────────────────────────────────────--

export interface StockInfo {
  productId: string;
  name: string;
  stock: number | null;
  variants: Array<{ variantId: string; name: string; stock: number | null }>;
}

// ── Customer service ──────────────────────────────────────────────────────--

export interface Conversation {
  conversationId: string;
  buyerName: string;
  lastMessage: string;
  unread: boolean;
  updatedAt: string; // ISO 8601
}

export interface Review {
  reviewId: string;
  productId: string;
  rating: number; // 1-5
  comment: string;
  buyerName: string;
  replied: boolean;
  createdAt: string; // ISO 8601
}

// ── Orders & fulfillment ────────────────────────────────────────────────────

export type OrderStatus =
  | "unpaid"
  | "to_ship"
  | "shipped"
  | "completed"
  | "cancelled"
  | "unknown";

export interface OrderLineItem {
  productId: string;
  variantId?: string;
  name: string;
  quantity: number;
  price: Money | null;
}

export interface Address {
  name: string;
  phone?: string;
  line1: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface OrderSummary {
  orderId: string;
  status: OrderStatus;
  total: Money | null;
  buyerName: string;
  createdAt: string; // ISO 8601
}

export interface Order extends OrderSummary {
  items: OrderLineItem[];
  shipTo: Address | null;
  shipByDeadline?: string; // ISO 8601
  trackingNumber?: string;
}

export interface ShippingInfo {
  orderId: string;
  carrier?: string;
  method?: "pickup" | "dropoff" | "unknown";
  shipByDeadline?: string; // ISO 8601
  pickupAddress?: Address;
  requiredWeightKg?: number;
  requiredDimensions?: Dimensions;
  notes?: string;
}

export interface TrackingCheckpoint {
  status: string;
  description?: string;
  timestamp: string; // ISO 8601
}

export interface TrackingInfo {
  orderId: string;
  trackingNumber?: string;
  carrier?: string;
  currentStatus: string;
  checkpoints: TrackingCheckpoint[];
}

export interface ShipmentResult {
  orderId: string;
  method: "pickup" | "dropoff";
  trackingNumber?: string;
  scheduledAt?: string; // ISO 8601
}

export interface DocumentRef {
  orderId: string;
  format: "pdf" | "thermal";
  /** URL or base64 payload of the generated document. */
  document: string;
  encoding: "url" | "base64";
}

// ── Returns, cancellations & disputes ─────────────────────────────────────--

export type ReturnStatus = "pending" | "accepted" | "rejected" | "closed" | "unknown";

export interface ReturnRequest {
  returnId: string;
  orderId: string;
  status: ReturnStatus;
  reason: string;
  requestedAmount: Money | null;
  buyerName: string;
  evidenceImages: string[];
  createdAt: string; // ISO 8601
}

export interface Cancellation {
  cancellationId: string;
  orderId: string;
  status: string;
  reason: string;
  buyerName: string;
  createdAt: string; // ISO 8601
}

export interface Dispute {
  disputeId: string;
  orderId: string;
  status: string;
  reason: string;
  buyerName: string;
  createdAt: string; // ISO 8601
}

// ── Promotions ──────────────────────────────────────────────────────────────

export type VoucherStatus = "upcoming" | "ongoing" | "expired" | "unknown";

export interface VoucherDiscount {
  type: "fixed" | "percent";
  value: number;
  /** Cap on the discount amount for percent vouchers. */
  cap?: number;
}

export interface Voucher {
  voucherId: string;
  name: string;
  status: VoucherStatus;
  discount: VoucherDiscount;
  startAt: string; // ISO 8601
  endAt: string; // ISO 8601
  minSpend?: Money;
  usageLimit?: number;
  scope: "shop" | "product";
  productIds?: string[];
}

// ── Shop ────────────────────────────────────────────────────────────────────

export interface ShopInfo {
  shopId: string;
  name: string;
  region: string;
  status: string;
  /** Whether the stored access token is currently valid / refreshable. */
  authHealthy: boolean;
}

export interface ShopPerformance {
  period: string;
  sales?: Money;
  orders?: number;
  rating?: number;
  responseRate?: number;
  penaltyPoints?: number;
  metrics: Record<string, number | string>;
}
