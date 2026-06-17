# sellabot-mcp

> The automation layer for marketplace selling. Claude is the interface; this MCP server is the hands.

## 1. Project Overview

**sellabot-mcp** is a [Model Context Protocol](https://modelcontextprotocol.io) server that exposes e-commerce *seller* operations as tools an LLM can call. It lets Claude (Desktop, Code, or any MCP client) directly operate a marketplace seller account through natural conversation — check stock, reply to buyers, adjust prices, run promotions, and more — without the seller touching the web dashboard.

**What it does**
- Wraps marketplace seller APIs (Shopee first) behind a clean set of MCP tools.
- Handles the unglamorous parts — OAuth, HMAC request signing, token refresh, rate limiting, pagination, error mapping — so the model never has to.
- Presents a **platform-agnostic** vocabulary: a "product" is a product whether it lives on Shopee, Lazada, or TikTok Shop.

**Vision: platform-agnostic, Shopee first**
- v1 ships **Shopee** only, fully working.
- The architecture is designed so **Lazada** and **TikTok Shop** are added later by writing *one adapter each* — never by rewriting tool logic.
- Tools are defined once against a canonical domain model. Adapters translate canonical ⇄ platform-specific.

**Where it fits**
```
  Seller (human)  ──talks to──►  Claude  ──calls tools──►  sellabot-mcp  ──signed HTTP──►  Shopee / Lazada / TikTok
        ▲                                                        │
        └────────────── natural-language results ◄──────────────┘
```
Claude is the brain and the conversational UI. sellabot-mcp is the deterministic, auditable automation layer. This repo owns **none** of the intelligence and **all** of the integration plumbing.

**Scope in one line:** sellabot-mcp can do **anything a seller can do through the marketplace's APIs that doesn't require physically moving goods** — listings, pricing, stock, promotions, customer chat, order info, refunds, returns, cancellations, and disputes. The only hard boundary is the *physical* world (packing, carrying a parcel to a courier). Because some of those digital actions are still consequential — a refund, a conceded dispute, a price change — the server treats anything crucial as **human-gated: it proposes, the seller approves, and it asks when unsure** (see §3).

---

## 2. MCP Tools

All tools are **platform-agnostic**. Every tool accepts an optional `platform` parameter (default: `"shopee"`) and, where a seller manages multiple shops, an optional `shop_id`. Parameters and return values use the **canonical domain model** (see §5), not raw Shopee field names.

Conventions:
- IDs are strings (canonical), even when a platform uses ints internally.
- Money is `{ amount: number, currency: string }` (minor-unit-safe; see §5).
- All list tools support `limit` (default 50, max 100) and `cursor` for pagination.
- Mutating tools (`update_*`, `create_*`, `delete_*`, `reply_*`, `boost_*`, `respond_*`, `arrange_*`) are explicitly flagged and require the server to be running **outside** `--read-only` mode.
- **Every tool carries a risk tier** (`READ` / `ROUTINE` / `SENSITIVE` / `CRITICAL`). Tiers govern whether the seller must explicitly confirm before the action executes — see §3. The tier is noted in each tool's description so Claude knows when to pause and ask.

**Guiding scope rule:** sellabot-mcp aims to cover **every seller operation that does *not* require physically moving goods** — anything doable through the marketplace's seller APIs. The dividing line is *physical*, not *risky*: risky-but-digital actions (refunds, accepting returns, cancellations) are **in scope** but gated behind seller consent (§3); physical acts (packing, handing a parcel to a courier) are inherently out of scope because no API can perform them.

### Product tools
| Tool | Purpose | Key parameters |
|---|---|---|
| `get_products` | List/search products in the shop | `query?`, `status?` (`live`/`unlisted`/`banned`/`sold_out`), `limit?`, `cursor?` |
| `create_listing` | Create a new product listing | `name`, `description`, `category_id`, `price`, `stock`, `images[]`, `attributes?`, `logistics?`, `weight?`, `dimensions?` |
| `update_listing` | Edit an existing listing's content | `product_id`, plus any subset of the create fields to change |
| `delete_listing` | Remove/unlist a product | `product_id`, `mode?` (`unlist` \| `delete`, default `unlist` — safer) |

### Pricing tools
| Tool | Purpose | Key parameters |
|---|---|---|
| `get_price` | Current price(s) for a product and its variants | `product_id` |
| `update_price` | Set price for one product/variant | `product_id`, `variant_id?`, `price` |
| `bulk_update_price` | Set prices for many items in one call | `updates[]` of `{ product_id, variant_id?, price }` |

### Inventory tools
| Tool | Purpose | Key parameters |
|---|---|---|
| `get_stock` | Current stock for a product and its variants | `product_id` |
| `update_stock` | Set stock for one product/variant | `product_id`, `variant_id?`, `stock` |
| `get_low_stock_items` | List items at/below a threshold | `threshold?` (default 5), `limit?`, `cursor?` |

### Customer-service tools
| Tool | Purpose | Key parameters |
|---|---|---|
| `get_messages` | List conversations / unread buyer chats | `status?` (`unread`/`all`), `limit?`, `cursor?` |
| `reply_to_message` | Reply in a buyer conversation | `conversation_id`, `text`, `attachments?` |
| `get_reviews` | List product reviews/ratings | `product_id?`, `rating?`, `replied?`, `limit?`, `cursor?` |
| `reply_to_review` | Post a seller reply to a review | `review_id`, `text` |

### Order & Fulfillment tools
Claude can't physically pack or ship anything — but it *can* answer every question about an order and perform the **digital** fulfillment steps (booking the courier, generating the label) so the seller only has to do the physical handover. The read tools answer *"where do I ship this?"*, *"what's the shipping deadline?"*, *"where's my order?"*; the gated actions handle the paperwork.

| Tool | Tier | Purpose | Key parameters |
|---|---|---|---|
| `get_orders` | READ | List orders, filtered by fulfillment status | `status?` (`unpaid`/`to_ship`/`shipped`/`completed`/`cancelled`), `since?`, `limit?`, `cursor?` |
| `get_order` | READ | Full detail for one order: line items, buyer, recipient & **ship-to address**, totals, current status | `order_id` |
| `get_shipping_info` | READ | Shipping requirements: carrier/logistics channel, pickup vs drop-off, **ship-by deadline**, required parcel weight/dimensions, pickup address | `order_id` |
| `track_shipment` | READ | Current tracking status / latest checkpoint for a shipped order | `order_id` (or `tracking_number?`) |
| `arrange_shipment` | **CRITICAL** | Book courier pickup or drop-off for an order (the digital step; seller still hands over the parcel) | `order_id`, `method` (`pickup`/`dropoff`), `pickup_address?`, `pickup_time?` |
| `get_shipping_document` | ROUTINE | Generate/fetch the shipping label / airway bill for a confirmed shipment | `order_id`, `format?` (`pdf`/`thermal`) |

> The READ tools appear even in `--read-only` mode. `arrange_shipment` commits the shop to a shipment and is therefore **CRITICAL** — always confirmed with the seller first (§3).

### Returns, Cancellations & Disputes tools (crucial — always seller-gated)
These touch money and shop reputation, so **every action here is `CRITICAL`** and never executes without explicit seller consent (§3). The `get_*` tools let Claude surface and summarize what's pending; the `respond_*` tools act only after the seller approves the specific decision.

| Tool | Tier | Purpose | Key parameters |
|---|---|---|---|
| `get_returns` | READ | List return/refund requests from buyers | `status?` (`pending`/`accepted`/`rejected`/`closed`), `limit?`, `cursor?` |
| `get_return` | READ | Full detail of one return/refund request: reason, evidence photos, amount, buyer | `return_id` |
| `respond_to_return` | **CRITICAL** | Accept or reject a return/refund request (optionally a partial amount) | `return_id`, `decision` (`accept`/`reject`), `refund_amount?`, `reason?` |
| `get_cancellations` | READ | List buyer-initiated cancellation requests | `status?`, `limit?`, `cursor?` |
| `respond_to_cancellation` | **CRITICAL** | Accept or reject a cancellation request | `cancellation_id`, `decision` (`accept`/`reject`), `reason?` |
| `get_disputes` | READ | List disputes / complaints / escalations needing seller input | `status?`, `limit?`, `cursor?` |
| `respond_to_dispute` | **CRITICAL** | Submit the seller's response/evidence to a dispute or complaint | `dispute_id`, `message`, `evidence?`, `proposed_resolution?` |

> Claude's job here is to **read the case, explain it plainly, recommend an option, and wait.** It must never decide a refund or concede a dispute on its own — the seller's explicit yes is mandatory and cannot be configured away (§3).

### Promotion tools
| Tool | Purpose | Key parameters |
|---|---|---|
| `get_vouchers` | List shop vouchers/discounts | `status?` (`upcoming`/`ongoing`/`expired`), `limit?`, `cursor?` |
| `create_voucher` | Create a shop voucher | `name`, `discount` (`{type: 'fixed'\|'percent', value, cap?}`), `start_at`, `end_at`, `min_spend?`, `usage_limit?`, `scope?` (`shop`\|`product`), `product_ids?` |
| `boost_listing` | Boost/feature a listing (where supported) | `product_id`, `duration?` |

### Shop tools
| Tool | Purpose | Key parameters |
|---|---|---|
| `get_shop_info` | Shop profile, region, status, auth health | — |
| `get_shop_performance` | KPIs: sales, orders, rating, response rate, penalties | `period?` (`today`/`7d`/`30d`), `metrics?` |

> **Tool design rule:** a tool's name, description, and schema are written for *the model's understanding*, not the API's. Descriptions state side effects plainly ("This permanently changes the live price buyers see"). Destructive defaults are conservative.

---

## 3. Safety, Consent & Human-in-the-Loop

This is a load-bearing section, not a footnote. sellabot-mcp acts on a **live commercial shop** — wrong prices, mistaken refunds, or a conceded dispute cost real money and reputation. The design principle: **Claude proposes, the seller disposes.** The server is the enforcement point — it never trusts that the client UI happened to ask.

### Risk tiers
Every tool declares one tier. The tier is part of the tool's registration and drives the consent gate below.

| Tier | Meaning | Examples | Consent |
|---|---|---|---|
| `READ` | No side effects; only reads data | all `get_*`, `track_shipment` | None — always allowed (even in `--read-only`) |
| `ROUTINE` | Low-impact, easily reversible writes | `reply_to_message`, `update_stock`, `get_shipping_document` | Confirm by default; may be auto-approved via config |
| `SENSITIVE` | Consequential but recoverable | `update_price`, `bulk_update_price`, `create_listing`, `delete_listing`, `create_voucher`, `boost_listing` | **Explicit confirmation required** |
| `CRITICAL` | Money, contractual, or reputation impact; hard to undo | `respond_to_return`, `respond_to_cancellation`, `respond_to_dispute`, `arrange_shipment` | **Explicit confirmation required — can never be auto-approved** |

### The consent gate (server-enforced "preview → confirm → execute")
Mutating tools at `SENSITIVE`+ do **not** execute on first call. Instead the server:
1. **Validates** the request and computes the *exact* effect (e.g. "Price of *Widget A (Red, L)* changes RM29.90 → RM24.90 on the live listing").
2. **Asks the seller** for a yes/no on that specific effect via **MCP elicitation** (`elicitation/create`) — the MCP-native way for a server to request input from the human. The seller sees the concrete preview and approves or declines.
3. **Executes only on explicit approval**, then returns the result. A decline returns cleanly with no change made.

If the connected client **doesn't support elicitation**, the server falls back to a **two-step token** pattern: the first call returns `requires_confirmation: true` plus a human-readable preview and a short-lived `confirmation_token`; Claude relays the preview, gets the seller's yes in chat, and re-calls with the token. Either way, **a mutation never happens without a distinct, explicit human approval of the concrete action.**

> `CRITICAL` actions are always gated regardless of config. `SENSITIVE` is gated by default. Only `ROUTINE` can be relaxed (see `AUTO_CONFIRM_TIER` in §9), and even then `bulk_*` operations re-prompt above a configurable item count.

### Asking the seller questions (clarification)
When a request is **ambiguous or under-specified**, the server does not guess — it asks:
- Missing/ambiguous required input (which shop? which variant? what refund amount? which of 3 matching products?) → the server issues an **elicitation** prompt with a structured question and, where possible, the candidate options.
- If the client can't elicit, the tool returns a structured `needs_input` error naming exactly what's missing, so Claude asks in plain chat and retries.
- **Bias toward asking.** For anything `CRITICAL`, partial confidence is treated as a question, not a green light.

### What Claude should do (behavioral contract)
- For `READ`: answer freely, summarize, advise.
- For `SENSITIVE`/`CRITICAL`: **state the concrete action and its effect, give a recommendation, then wait for the seller's explicit go-ahead.** Never batch-approve. Never assume a prior "yes" covers a new action.
- On decline or silence: do nothing and say so.
- Always report what actually happened, including failures — never imply an action succeeded when it was gated, declined, or errored.

### Audit trail
Every mutating attempt — proposed effect, the consent decision (approved/declined/auto), timestamp, tool, params (secrets redacted), and outcome — is written to an append-only audit log (stderr + optional file via `AUDIT_LOG_PATH`). This makes "what did the bot change, and who approved it?" answerable after the fact.

---

## 4. Tech Stack Decisions

### Language & runtime — **TypeScript on Node.js 20 LTS**
- The official MCP SDK (`@modelcontextprotocol/sdk`) is TypeScript-first and the most battle-tested binding.
- All target platform APIs (Shopee/Lazada/TikTok) are REST + JSON — no native deps needed.
- Static types let us enforce the **adapter contract** at compile time: a new platform won't compile until it implements every canonical operation.
- Module system: **ESM** (`"type": "module"`). Build with `tsc` (or `tsup` for a single bundled entry).

### MCP SDK — **`@modelcontextprotocol/sdk`**
- Transport: **stdio** for v1 (how Claude Desktop & Claude Code launch local servers).
- Streamable HTTP transport is kept as a future option (hosted/multi-user mode) but out of scope for v1.
- Tools registered via the high-level `McpServer` API; input schemas defined with **Zod** and exported to JSON Schema automatically.

### Validation — **Zod**
- Single source of truth for tool input schemas *and* env-var validation.
- Reject bad input at the boundary with clear messages the model can act on.

### Shopee auth — **HMAC-SHA256 signing + OAuth2** (Open Platform API v2)
- **Every request** is signed. The base string and signing inputs differ for public vs shop-scoped calls (see §7).
- **OAuth2 authorization** grants a shop's `access_token` (~4h TTL) + `refresh_token`. A one-time CLI flow (`npm run authorize`) captures the `code` and exchanges it for tokens.
- Signing and token logic live entirely in the Shopee adapter — tools and the core never see a signature.

### Token storage & refresh — **SQLite (encrypted at rest), behind a `TokenStore` interface**
- Library: Node's built-in **`node:sqlite`** (`DatabaseSync`) — synchronous, zero-config, single file, and **no native build step** (chosen over `better-sqlite3`, which needs a C++ toolchain to compile on Windows). DB path via `TOKEN_DB_PATH`. Requires Node 22.5+ (we target Node 20+ but the token store specifically needs a `node:sqlite`-capable runtime; Node 24 is what this repo runs on).
- Token fields are **encrypted with AES-256-GCM** using a key derived from `TOKEN_ENCRYPTION_KEY`. The DB file alone is useless without the key.
- **Proactive refresh:** before any shop-scoped call, if the access token expires within a safety window (e.g. 10 min), refresh first. A single-flight lock prevents concurrent refresh storms.
- `TokenStore` is an interface (`get/set/delete` by `platform + shop_id`) so the SQLite impl can later be swapped for Redis/Postgres in hosted mode without touching adapters.

### Error handling — **typed error hierarchy + retry + safe MCP mapping**
- Internal hierarchy: `SellabotError` → `AuthError`, `RateLimitError`, `ValidationError`, `PlatformError`, `NotFoundError`, `TransientError`.
- **Retries:** transient failures (429, 5xx, network) retried with exponential backoff + jitter; respects `Retry-After`. Mutations are retried only when proven idempotent.
- **MCP mapping:** every tool runs inside a wrapper that catches errors and returns a structured tool error (`isError: true`) with a human-readable, model-actionable message — never a raw stack trace or secret. Platform error codes are preserved in a `details` field.
- **Logging:** structured logs to **stderr only** (stdout is the MCP transport — never write to it). Secrets and tokens are redacted.

---

## 5. Project Structure

The directory layout makes "add a platform" a localized, additive change.

```
sellabot-mcp/
├─ CLAUDE.md                  # this file — the project bible
├─ README.md
├─ package.json
├─ tsconfig.json
├─ .env.example
├─ .gitignore                 # ignores .env, *.db, dist/
│
├─ src/
│  ├─ index.ts                # entry: boots MCP server over stdio
│  ├─ server.ts               # creates McpServer, registers all tools
│  ├─ config.ts               # loads + validates env (Zod), builds runtime config
│  │
│  ├─ tools/                  # PLATFORM-AGNOSTIC tool definitions
│  │  ├─ index.ts             # registerAllTools(server, deps)
│  │  ├─ products.ts
│  │  ├─ pricing.ts
│  │  ├─ inventory.ts
│  │  ├─ customer-service.ts
│  │  ├─ orders.ts            # get_orders/get_order/shipping/track/arrange_shipment
│  │  ├─ returns.ts          # returns, cancellations & disputes (CRITICAL responses)
│  │  ├─ promotions.ts
│  │  └─ shop.ts
│  │     # each file: defines schema, resolves platform via registry,
│  │     # calls platform.<method>(), returns canonical result.
│  │     # NO Shopee-specific code lives here.
│  │
│  ├─ core/                   # platform-neutral plumbing
│  │  ├─ platform.ts          # `Platform` interface — THE adapter contract
│  │  ├─ registry.ts          # resolve platform by name; holds configured adapters
│  │  ├─ models.ts            # canonical domain models (Product, Money, Message…)
│  │  ├─ errors.ts            # SellabotError hierarchy (+ NeedsInputError)
│  │  ├─ consent.ts           # risk tiers + preview→confirm→execute gate + elicitation
│  │  ├─ audit.ts             # append-only audit log of proposed/approved/executed actions
│  │  ├─ token-store.ts       # TokenStore interface + SQLite impl + crypto
│  │  ├─ http.ts              # fetch wrapper: retries, backoff, timeouts
│  │  └─ logger.ts            # stderr structured logger w/ secret redaction
│  │
│  ├─ platforms/              # one self-contained folder per marketplace
│  │  ├─ shopee/
│  │  │  ├─ adapter.ts        # implements Platform using client + mappers
│  │  │  ├─ client.ts         # signed HTTP client (HMAC-SHA256)
│  │  │  ├─ auth.ts           # OAuth2 exchange + token refresh
│  │  │  ├─ sign.ts           # signature base-string construction
│  │  │  ├─ endpoints.ts      # path constants + region host map
│  │  │  ├─ mappers.ts        # Shopee JSON ⇄ canonical models
│  │  │  └─ types.ts          # raw Shopee response types
│  │  ├─ lazada/              # (future) same shape as shopee/
│  │  └─ tiktok/              # (future) same shape as shopee/
│  │
│  └─ auth/
│     └─ oauth-callback.ts    # tiny local HTTP server to capture auth code
│
├─ scripts/
│  └─ authorize.ts            # `npm run authorize` — one-time shop OAuth flow
│
└─ test/
   ├─ shopee/sign.test.ts     # signature correctness (golden vectors)
   ├─ shopee/mappers.test.ts  # mapping round-trips
   └─ tools/*.test.ts         # tools tested against a mock Platform
```

**Dependency direction (strict):**
`tools/` → `core/` → `platforms/*`. Tools depend on the `Platform` *interface*, never on a concrete adapter. Adapters depend on `core/` utilities but nothing in `tools/`. This is what keeps platform code swappable.

---

## 6. Platform Expansion Strategy

The whole architecture exists to make this section cheap.

### The contract: `core/platform.ts`
A single interface every marketplace must satisfy:

```ts
interface Platform {
  readonly name: 'shopee' | 'lazada' | 'tiktok';

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
  arrangeShipment(p: ArrangeShipmentParams): Promise<ShipmentResult>;       // CRITICAL
  getShippingDocument(p: ShippingDocumentParams): Promise<DocumentRef>;

  // returns, cancellations & disputes (all responses are CRITICAL)
  getReturns(p: GetReturnsParams): Promise<Page<ReturnRequest>>;
  getReturn(p: { returnId: string }): Promise<ReturnRequest>;
  respondToReturn(p: RespondToReturnParams): Promise<void>;                 // CRITICAL
  getCancellations(p: GetCancellationsParams): Promise<Page<Cancellation>>;
  respondToCancellation(p: RespondToCancellationParams): Promise<void>;     // CRITICAL
  getDisputes(p: GetDisputesParams): Promise<Page<Dispute>>;
  respondToDispute(p: RespondToDisputeParams): Promise<void>;               // CRITICAL

  // promotions
  getVouchers(p: GetVouchersParams): Promise<Page<Voucher>>;
  createVoucher(p: CreateVoucherParams): Promise<Voucher>;
  boostListing(p: BoostParams): Promise<void>;

  // shop
  getShopInfo(): Promise<ShopInfo>;
  getShopPerformance(p: PerformanceParams): Promise<ShopPerformance>;
}
```

### Rules that keep it clean
1. **Tools never import an adapter.** They call `registry.resolve(platform)` and get back a `Platform`. The tool logic is identical across marketplaces.
2. **Canonical models are the lingua franca.** `mappers.ts` in each adapter is the *only* place that knows platform field names. Tools, the registry, and the model never see `item_id` vs `product_id` differences.
3. **Capability flags for gaps.** Not every platform supports every operation (e.g. boosting). The `Platform` may expose a `capabilities` set; unsupported ops throw a typed `UnsupportedOperationError` that maps to a clear "TikTok Shop doesn't support X" tool message — Claude handles it gracefully.
4. **Auth is per-adapter.** OAuth/HMAC details are wildly different per platform and stay fully inside `platforms/<name>/auth.ts` + `sign.ts`. Only the `TokenStore` interface is shared.
5. **Adding Lazada =** copy the `shopee/` folder shape, implement `Platform`, register it in `registry.ts`, add its env vars. **No tool file changes. No core changes.**

---

## 7. Shopee API Details

Target: **Shopee Open Platform API v2**.

### Base URLs (host depends on environment)
- **Sandbox/test:** `https://partner.test-stable.shopeemobile.com`
- **Production:** `https://partner.shopeemobile.com`

> Region (`SG`, `MY`, `ID`, `TH`, `VN`, `PH`, `TW`, `BR`) determines the seller's data but the API host above is shared; region is carried via the shop's authorization, not a different domain. Confirm the exact host/region mapping against current Shopee docs at integration time — Shopee occasionally adjusts regional hosts.

### Required env vars
| Var | Meaning |
|---|---|
| `SHOPEE_PARTNER_ID` | Your Open Platform app's partner ID (numeric) |
| `SHOPEE_PARTNER_KEY` | Partner secret key used as the HMAC-SHA256 key |
| `SHOPEE_REGION` | Seller region code, e.g. `MY` |
| `SHOPEE_ENV` | `sandbox` \| `production` (selects base host) |
| `SHOPEE_SHOP_ID` | Authorized shop ID (set after running `npm run authorize`) |
| `SHOPEE_REDIRECT_URL` | OAuth redirect captured by the local callback server |

### HMAC-SHA256 signing (the core ritual)
Shopee requires a signature on every call. Construction differs by call type:

- **Public APIs** (e.g. token exchange/refresh):
  `base_string = partner_id + api_path + timestamp`
- **Shop-scoped APIs** (everything operational):
  `base_string = partner_id + api_path + timestamp + access_token + shop_id`
- **Merchant-scoped APIs** (for merchant-level calls, if used):
  `base_string = partner_id + api_path + timestamp + access_token + merchant_id`

Then:
```
sign = HEX( HMAC_SHA256( key = partner_key, message = base_string ) )
```
Common query params on every request: `partner_id`, `timestamp` (Unix seconds, must be within ~5 min of Shopee's clock), `sign`, plus `access_token` + `shop_id` for shop-scoped calls.

All of this is implemented once in `platforms/shopee/sign.ts` + `client.ts` and verified by golden-vector unit tests.

### OAuth2 flow (one-time, per shop)
1. Build the authorization URL (signed with the public-API scheme) → seller opens it and approves.
2. Shopee redirects to `SHOPEE_REDIRECT_URL` with `?code=…&shop_id=…`. The local `oauth-callback.ts` server captures it.
3. Exchange `code` → `access_token` + `refresh_token` via the token endpoint.
4. Persist tokens (encrypted) in the `TokenStore`. Thereafter the adapter auto-refreshes.

Access tokens live ~4 hours; refresh tokens are longer-lived but single-use on refresh (each refresh returns a new refresh token — store it).

### Rate limiting
- Shopee enforces per-API and per-shop rate limits (and a global QPS ceiling per partner).
- Strategy: the shared `core/http.ts` client backs off on `429`/quota errors with exponential backoff + jitter and honors any `Retry-After`. `bulk_*` tools chunk work and pace requests rather than firing in parallel bursts.
- Be conservative by default; surfacing a "rate limited, retrying" state to Claude is better than getting the partner app throttled.

---

## 8. Key Commands

```bash
# Install
npm install

# Build (TypeScript → dist/)
npm run build

# Dev (run from source with tsx, hot-ish)
npm run dev

# One-time: authorize a Shopee shop (opens browser, captures OAuth code)
npm run authorize

# Run the built MCP server over stdio
npm start

# Tests
npm test
```

### Connect to Claude Desktop
Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`; Windows: `%APPDATA%\Claude\`):
```json
{
  "mcpServers": {
    "sellabot": {
      "command": "node",
      "args": ["C:\\Users\\Rexton\\sellabot_mcp\\dist\\index.js"],
      "env": {
        "SHOPEE_PARTNER_ID": "…",
        "SHOPEE_PARTNER_KEY": "…",
        "SHOPEE_REGION": "MY",
        "SHOPEE_ENV": "production",
        "TOKEN_ENCRYPTION_KEY": "…"
      }
    }
  }
}
```

### Connect to Claude Code
```bash
claude mcp add sellabot -- node C:\Users\Rexton\sellabot_mcp\dist\index.js
# or, for project scope, add to .mcp.json in the consuming repo
```

> Tip: during development, run with `--read-only` to register only the `get_*` tools — safe for testing against a live shop without risk of mutating prices/stock.

---

## 9. Environment Variables (`.env.example`)

```dotenv
# ── Shopee Open Platform ─────────────────────────────────────────
SHOPEE_PARTNER_ID=
SHOPEE_PARTNER_KEY=
SHOPEE_REGION=MY                # SG | MY | ID | TH | VN | PH | TW | BR
SHOPEE_ENV=sandbox              # sandbox | production
SHOPEE_SHOP_ID=                 # filled in after `npm run authorize`
SHOPEE_REDIRECT_URL=http://localhost:8787/callback

# ── Token storage (encrypted at rest) ────────────────────────────
TOKEN_DB_PATH=./.data/tokens.db
TOKEN_ENCRYPTION_KEY=           # 32-byte key (base64/hex) for AES-256-GCM

# ── OAuth callback server (used only by `npm run authorize`) ──────
OAUTH_CALLBACK_PORT=8787

# ── Server behavior ──────────────────────────────────────────────
READ_ONLY=false                 # true = expose only READ-tier (get_*) tools
LOG_LEVEL=info                  # debug | info | warn | error
REQUEST_TIMEOUT_MS=15000
MAX_RETRIES=3

# ── Consent & safety (see §3) ────────────────────────────────────
AUTO_CONFIRM_TIER=none          # none | routine  (SENSITIVE & CRITICAL can NEVER be auto-confirmed)
BULK_CONFIRM_THRESHOLD=10       # re-prompt for bulk_* operations affecting more than N items
AUDIT_LOG_PATH=./.data/audit.log  # append-only record of proposed/approved/executed actions

# ── Future platforms (placeholders, unused in v1) ────────────────
# LAZADA_APP_KEY=
# LAZADA_APP_SECRET=
# TIKTOK_APP_KEY=
# TIKTOK_APP_SECRET=
```

> `.env` is git-ignored. Never commit real keys. `TOKEN_ENCRYPTION_KEY` is required even in dev — losing it means re-authorizing all shops.

---

## 10. Out of Scope (v1, deliberately)

**The boundary is physical, not digital.** If the marketplace API can do it, sellabot-mcp is in scope to do it (gated by consent where crucial, §3). The exclusions below are things that are *physical*, *autonomous*, or *architecturally deferred* — not "risky digital actions," which are in scope.

This MCP server intentionally does **not**:
- **Move physical goods.** It cannot pack, label-stick, carry, or hand a parcel to a courier. It *can* do the digital half — `arrange_shipment` books the pickup and `get_shipping_document` produces the label — but the physical handover is always the human's job. This is the one true hard boundary.
- **Make selling decisions autonomously.** It executes; the seller decides. Claude may *recommend* a price, a refund, or a dispute response, but the action is gated on the seller's explicit yes (§3). No pricing AI, no auto-reply bot, no auto-approving refunds living in this repo.
- **Act on `CRITICAL` items without consent — ever.** Refunds, returns, cancellations, disputes, and shipment commitments cannot be auto-confirmed by any config. (See §3; this is a design invariant, not a default.)
- **Provide a UI.** No web dashboard, no frontend. The conversational client *is* the UI.
- **Run as a multi-tenant hosted service** in v1. It's a local, single-operator stdio server. (Hosted HTTP mode + Redis/Postgres token store is a designed-for future, not a v1 deliverable.)
- **Move money beyond marketplace refund flows.** Approving a buyer's refund/return (a standard seller API action) is in scope and gated. Wallet management, payouts/withdrawals, settlement, accounting, invoicing, and tax are **out** — they're a separate financial domain, not day-to-day shop operation.
- **Cross-post or sync listings between platforms.** Each platform is operated independently in v1; cross-platform sync is a future feature built *on top of* the adapters, not inside them.
- **Scrape or automate the Shopee web UI.** Official Open Platform API only — no browser automation, no unofficial endpoints.
- **Persist business data.** The only thing stored locally is encrypted auth tokens. Product/order data is always fetched live.
- **Bypass platform rules, rate limits, or ToS.** The server is a polite API client by design.

---

*This document is the source of truth for sellabot-mcp's design. Update it when decisions change — code follows CLAUDE.md, not the other way around.*
