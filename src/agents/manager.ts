/**
 * Manager Agent — the conversational coordinator.
 *
 * This is the only agent the seller talks to. It interprets intent and
 * delegates work to two specialists:
 *   - Operating Agent  → shop operations (orders, stock, messages, listings…)
 *   - Promoting Agent  → Shopee-native promotion (boost, vouchers)
 *
 * The Manager keeps a high-level conversation; each specialist keeps its own
 * detailed history so multi-step flows (photo → draft → confirm) work.
 */
import { logger } from "../core/logger.js";
import type { Platform } from "../core/platform.js";
import type { AuditLog } from "../core/audit.js";
import type { Config } from "../config.js";
import { OperatingAgent } from "./operating-agent.js";
import { PromotingAgent } from "./promoting-agent.js";
import {
  runAgentLoop,
  ActivityTracker,
  type Message,
  type ActivityEntry,
} from "./runtime.js";

// Re-export so existing imports (telegram bot) keep working.
export type { ActivityEntry } from "./runtime.js";

const MANAGER_TOOLS = [
  {
    name: "delegate_to_operations",
    description:
      "Delegate a shop-operations task to the Operating Agent: checking orders, stock/inventory, buyer messages, reviews, returns, shop performance, briefings/reports, or creating a product listing. Pass a clear task description including any details the seller gave (price, stock, confirmation, etc.).",
    input_schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What the Operating Agent should do, in plain language with all relevant details." },
      },
      required: ["task"],
    },
  },
  {
    name: "delegate_to_promotions",
    description:
      "Delegate a promotion/marketing task to the Promoting Agent: boosting a listing to the top of Shopee search, or creating a discount voucher. Pass a clear task description including any details or confirmation from the seller.",
    input_schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What the Promoting Agent should do, in plain language with all relevant details." },
      },
      required: ["task"],
    },
  },
] as const;

const SYSTEM_PROMPT = `You are Sellabot's Manager Agent — the coordinator a Shopee seller in Malaysia talks to on Telegram.

You do not do shop work yourself. You have two specialist agents and you delegate to them:
- Operating Agent (delegate_to_operations): orders, stock/inventory, buyer messages, reviews, returns, shop performance, morning briefing / evening report, and creating product listings from photos.
- Promoting Agent (delegate_to_promotions): boosting a listing to the top of Shopee search, and creating discount vouchers. (Shopee's paid pay-per-click ads are NOT available via API — the Promoting Agent will explain and offer boost + vouchers instead.)

How to work:
- For anything about the shop's data or listings → delegate_to_operations.
- For anything about promoting, boosting, ads, discounts or vouchers → delegate_to_promotions.
- When the seller sent a product photo, delegate to operations with a task describing it (and note the caption/price/stock they gave).
- When the seller confirms something ("yes", "post it", "boost it", "create it") → delegate to the SAME specialist that made the proposal, telling it the seller confirmed, so it can execute.
- You may answer directly ONLY for greetings, small talk, or to ask a short clarifying question. Everything operational or promotional goes to a specialist.
- Relay the specialist's answer to the seller in concise, friendly plain text (no markdown). Do not invent data.`;

export class ManagerAgent {
  private history: Message[] = [];
  private readonly maxHistory = 24;
  private pendingImageBase64: string | null = null;

  private readonly tracker = new ActivityTracker();
  private readonly operating: OperatingAgent;
  private readonly promoting: PromotingAgent;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    adapter: Platform,
    audit: AuditLog,
    config: Config,
  ) {
    this.operating = new OperatingAgent(apiKey, model, adapter, audit, config, this.tracker);
    this.promoting = new PromotingAgent(apiKey, model, adapter, audit, config, this.tracker);
  }

  /** Recent actions across all agents, newest first (feeds Telegram /activity). */
  get activityLog(): ActivityEntry[] {
    return this.tracker.entries;
  }

  async chat(userMessage: string): Promise<string> {
    this.history.push({ role: "user", content: userMessage });
    this.trim();
    return this.run();
  }

  async chatWithImage(userMessage: string, imageBase64: string, _mimeType: string): Promise<string> {
    // The Manager doesn't need vision — it forwards the image to the Operating
    // Agent. We stash the bytes and note the photo in the Manager's history.
    this.pendingImageBase64 = imageBase64;
    const caption = userMessage?.trim();
    this.history.push({
      role: "user",
      content: `[The seller sent a product photo to list on Shopee.${caption ? ` Caption: "${caption}"` : " No caption."}]`,
    });
    this.trim();
    return this.run();
  }

  private async run(): Promise<string> {
    try {
      return await runAgentLoop(
        {
          apiKey: this.apiKey,
          model: this.model,
          system: SYSTEM_PROMPT,
          tools: MANAGER_TOOLS,
          label: "manager agent",
          executeTool: (name, input) => this.delegate(name, input),
          onTool: (name, _input, result) => this.tracker.record("manager", name, result),
        },
        this.history,
      );
    } catch (err) {
      logger.error("manager agent error", { error: (err as Error).message });
      return `Sorry, something went wrong: ${(err as Error).message}`;
    }
  }

  private async delegate(name: string, input: Record<string, unknown>): Promise<string> {
    const task = (input.task as string) ?? "";
    if (name === "delegate_to_operations") {
      // Hand the pending image to operations once, then clear it here so it
      // isn't re-sent on later delegations.
      const image = this.pendingImageBase64 ?? undefined;
      this.pendingImageBase64 = null;
      return this.operating.handle(task, image);
    }
    if (name === "delegate_to_promotions") {
      return this.promoting.handle(task);
    }
    return `Unknown delegation: ${name}`;
  }

  clearHistory(): void {
    this.history = [];
    this.pendingImageBase64 = null;
    this.operating.clearHistory();
    this.promoting.clearHistory();
  }

  get isAvailable(): boolean {
    return !!this.apiKey;
  }

  private trim(): void {
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
  }
}
