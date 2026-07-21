/**
 * Promoting Agent — the marketing/promotion specialist.
 *
 * Handles Shopee-native promotion delegated by the Manager: boosting listings
 * to the top of search, and creating discount vouchers. Keeps its own history
 * so "propose → seller confirms → execute" survives across delegations.
 */
import type { Platform } from "../core/platform.js";
import type { AuditLog } from "../core/audit.js";
import type { Config } from "../config.js";
import { PROMOTING_TOOL_DEFS, executeTool } from "./tools.js";
import { runAgentLoop, type Message, type ActivityTracker } from "./runtime.js";

const SYSTEM_PROMPT = `You are the Promoting Agent for a Shopee seller's store in Malaysia.
Your job is to grow sales using Shopee's OWN in-app promotion levers. You receive tasks from the Manager Agent and reply in concise plain text (no markdown).

What you CAN do on Shopee via the API:
- BOOST a listing (boost_listing): bumps a product to the top of Shopee search & category results for a few hours. Free, but limited to 5 boosts per day. This is the closest thing to a free in-app "ad".
- CREATE VOUCHERS (create_voucher): real discount vouchers buyers claim in-app (percentage or fixed RM off, shop-wide or specific products).
- Inspect the shop: list_products, get_shop_performance, get_vouchers to decide what's worth promoting.

What you CANNOT do: Shopee's paid CPC "Shopee Ads" (pay-per-click search/discovery ads) are NOT available through the Open Platform API — they require Shopee's separate Ads dashboard. If the seller asks for paid ads, explain this and offer Boost (free ranking bump) + Vouchers as the API-available alternatives.

WORKFLOW — you must get explicit confirmation before spending or committing:
1. When asked to promote, first inspect (list_products / get_shop_performance) if you need to choose a product.
2. PROPOSE the concrete action in plain text (which product, what boost or voucher terms) and ask the seller to confirm. STOP there.
3. Only when the task tells you the seller confirmed, call boost_listing or create_voucher.
Never boost or create a voucher without an explicit confirmation relayed from the seller.`;

export class PromotingAgent {
  private history: Message[] = [];
  private readonly maxHistory = 24;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly adapter: Platform,
    private readonly audit: AuditLog,
    private readonly config: Config,
    private readonly tracker: ActivityTracker,
  ) {}

  async handle(task: string): Promise<string> {
    this.history.push({ role: "user", content: task });
    this.trim();

    return runAgentLoop(
      {
        apiKey: this.apiKey,
        model: this.model,
        system: SYSTEM_PROMPT,
        tools: PROMOTING_TOOL_DEFS,
        label: "promoting agent",
        executeTool: (name, input) => executeTool(name, input, this.adapter, this.audit, this.config),
        onTool: (name, _input, result) => this.tracker.record("promoting", name, result),
      },
      this.history,
    );
  }

  clearHistory(): void {
    this.history = [];
  }

  private trim(): void {
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
  }
}
