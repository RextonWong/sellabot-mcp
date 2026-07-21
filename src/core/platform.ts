/**
 * The adapter contract. Every marketplace implements this interface against the
 * canonical domain model. Tools depend ONLY on this interface — never on a
 * concrete adapter — which is what keeps platforms swappable (CLAUDE.md §6).
 */
import type {
  BulkResult,
  Cancellation,
  Conversation,
  DocumentRef,
  Dimensions,
  Dispute,
  Money,
  Order,
  OrderStatus,
  OrderSummary,
  Page,
  PageParams,
  PlatformName,
  PriceInfo,
  Product,
  ProductStatus,
  ReturnRequest,
  ReturnStatus,
  Review,
  ShipmentResult,
  ShippingInfo,
  ShopInfo,
  ShopPerformance,
  StockInfo,
  TrackingInfo,
  Voucher,
  VoucherDiscount,
  VoucherStatus,
} from "./models.js";

// ── Parameter shapes ──────────────────────────────────────────────────────--

export interface GetProductsParams extends PageParams {
  query?: string;
  status?: ProductStatus;
}

export interface CreateListingParams {
  name: string;
  description: string;
  categoryId: string;
  price: Money;
  stock: number;
  images: string[];
  /** Brand info. Shopee requires this for many categories; id 0 = No Brand. */
  brand?: { id?: string; name?: string };
  attributes?: Record<string, unknown>;
  weightKg?: number;
  dimensions?: Dimensions;
}

export interface UpdateListingParams {
  productId: string;
  name?: string;
  description?: string;
  categoryId?: string;
  images?: string[];
  attributes?: Record<string, unknown>;
  weightKg?: number;
  dimensions?: Dimensions;
}

export interface DeleteListingParams {
  productId: string;
  mode: "unlist" | "delete";
}

export interface UpdatePriceParams {
  productId: string;
  variantId?: string;
  price: Money;
}

export interface BulkPriceParams {
  updates: Array<{ productId: string; variantId?: string; price: Money }>;
}

export interface UpdateStockParams {
  productId: string;
  variantId?: string;
  stock: number;
}

export interface GetMessagesParams extends PageParams {
  status?: "unread" | "all";
}

export interface ReplyMessageParams {
  conversationId: string;
  text: string;
  attachments?: string[];
}

export interface GetReviewsParams extends PageParams {
  productId?: string;
  rating?: number;
  replied?: boolean;
}

export interface ReplyReviewParams {
  reviewId: string;
  text: string;
}

export interface GetOrdersParams extends PageParams {
  status?: OrderStatus;
  since?: string;
}

export interface TrackShipmentParams {
  orderId?: string;
  trackingNumber?: string;
}

export interface ArrangeShipmentParams {
  orderId: string;
  method: "pickup" | "dropoff";
  pickupTime?: string;
}

export interface ShippingDocumentParams {
  orderId: string;
  format?: "pdf" | "thermal";
}

export interface GetReturnsParams extends PageParams {
  status?: ReturnStatus;
}

export interface RespondToReturnParams {
  returnId: string;
  decision: "accept" | "reject";
  refundAmount?: Money;
  reason?: string;
}

export interface GetCancellationsParams extends PageParams {
  status?: string;
}

export interface RespondToCancellationParams {
  cancellationId: string;
  decision: "accept" | "reject";
  reason?: string;
}

export interface GetDisputesParams extends PageParams {
  status?: string;
}

export interface RespondToDisputeParams {
  disputeId: string;
  message: string;
  evidence?: string[];
  proposedResolution?: string;
}

export interface GetVouchersParams extends PageParams {
  status?: VoucherStatus;
}

export interface CreateVoucherParams {
  name: string;
  discount: VoucherDiscount;
  startAt: string;
  endAt: string;
  minSpend?: Money;
  usageLimit?: number;
  scope: "shop" | "product";
  productIds?: string[];
}

export interface BoostParams {
  productId: string;
  durationHours?: number;
}

export interface PerformanceParams {
  period?: "today" | "7d" | "30d";
  metrics?: string[];
}

// ── Capabilities ──────────────────────────────────────────────────────────--

/** Operations a platform may or may not support; tools surface gaps gracefully. */
export type Capability =
  | "products"
  | "pricing"
  | "inventory"
  | "customer_service"
  | "reviews"
  | "orders"
  | "fulfillment"
  | "returns"
  | "disputes"
  | "vouchers"
  | "boost"
  | "performance";

// ── The contract ──────────────────────────────────────────────────────────--

export interface Platform {
  readonly name: PlatformName;
  readonly capabilities: ReadonlySet<Capability>;

  // products
  getProducts(p: GetProductsParams): Promise<Page<Product>>;
  createListing(p: CreateListingParams): Promise<Product>;
  updateListing(p: UpdateListingParams): Promise<Product>;
  deleteListing(p: DeleteListingParams): Promise<void>;

  // pricing
  getPrice(p: { productId: string }): Promise<PriceInfo>;
  updatePrice(p: UpdatePriceParams): Promise<void>;
  bulkUpdatePrice(p: BulkPriceParams): Promise<BulkResult>;

  // inventory
  getStock(p: { productId: string }): Promise<StockInfo>;
  updateStock(p: UpdateStockParams): Promise<void>;
  getLowStockItems(p: { threshold: number } & PageParams): Promise<Page<StockInfo>>;

  // customer service
  getMessages(p: GetMessagesParams): Promise<Page<Conversation>>;
  replyToMessage(p: ReplyMessageParams): Promise<void>;
  getReviews(p: GetReviewsParams): Promise<Page<Review>>;
  replyToReview(p: ReplyReviewParams): Promise<void>;

  // orders & fulfillment
  getOrders(p: GetOrdersParams): Promise<Page<OrderSummary>>;
  getOrder(p: { orderId: string }): Promise<Order>;
  getShippingInfo(p: { orderId: string }): Promise<ShippingInfo>;
  trackShipment(p: TrackShipmentParams): Promise<TrackingInfo>;
  arrangeShipment(p: ArrangeShipmentParams): Promise<ShipmentResult>; // CRITICAL
  getShippingDocument(p: ShippingDocumentParams): Promise<DocumentRef>;

  // returns, cancellations & disputes (responses are CRITICAL)
  getReturns(p: GetReturnsParams): Promise<Page<ReturnRequest>>;
  getReturn(p: { returnId: string }): Promise<ReturnRequest>;
  respondToReturn(p: RespondToReturnParams): Promise<void>; // CRITICAL
  getCancellations(p: GetCancellationsParams): Promise<Page<Cancellation>>;
  respondToCancellation(p: RespondToCancellationParams): Promise<void>; // CRITICAL
  getDisputes(p: GetDisputesParams): Promise<Page<Dispute>>;
  respondToDispute(p: RespondToDisputeParams): Promise<void>; // CRITICAL

  // promotions
  getVouchers(p: GetVouchersParams): Promise<Page<Voucher>>;
  createVoucher(p: CreateVoucherParams): Promise<Voucher>;
  boostListing(p: BoostParams): Promise<void>;

  // shop
  getShopInfo(): Promise<ShopInfo>;
  getShopPerformance(p: PerformanceParams): Promise<ShopPerformance>;

  // listing creation helpers (optional — not all platforms support)
  uploadImage?(imageBase64: string): Promise<string>;
  searchCategories?(keyword: string): Promise<Array<{ id: string; name: string; path: string }>>;
}
