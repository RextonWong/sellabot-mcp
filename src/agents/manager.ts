/**
 * Manager Agent — the conversational brain of sellabot.
 *
 * Receives natural-language messages (from Telegram), uses Claude with tool_use
 * to interpret intent and dispatch to Shopee/Marketing agent tools, then returns
 * a plain-text response for Telegram.
 *
 * Maintains a per-session conversation history so follow-up messages work
 * ("what about the second one?" etc.).
 */
import { logger } from "../core/logger.js";
import type { Platform } from "../core/platform.js";
import type { AuditLog } from "../core/audit.js";
import type { Config } from "../config.js";
import { TOOL_DEFINITIONS, executeTool, type ToolContext } from "./tools.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TextBlock   { type: "text"; text: string }
interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
type ContentBlock = TextBlock | ToolUseBlock;

interface AnthropicResponse {
  stop_reason: "end_turn" | "tool_use" | string;
  content: ContentBlock[];
}

// Tracks recent actions for /activity command
export interface ActivityEntry {
  ts: string;
  agent: "shopee" | "marketing";
  tool: string;
  summary: string;
}

const SHOPEE_TOOLS = new Set([
  "get_orders", "get_inventory", "get_low_stock", "get_messages", "get_reviews",
  "get_returns", "get_shop_performance", "run_briefing", "run_report",
  "upload_product_image", "search_categories", "draft_listing", "create_listing",
]);

const SYSTEM_PROMPT = `You are Sellabot, an AI assistant managing a Shopee seller's store in Malaysia.

You have two groups of capabilities:
- Shopee Agent: check orders, stock, messages, reviews, returns, shop performance, run briefings, create product listings
- Marketing Agent: propose vouchers, generate ad copy for social media

LISTING CREATION (when seller sends a product photo):
1. Call upload_product_image to upload the image to Shopee's CDN first.
2. Analyse the product from the image and the seller's caption — name, features, selling points.
3. Call search_categories with a broad keyword (e.g. "kitchen", "electronics", "fashion", "baby", "sports", "beauty"). Try the product type, then a broader category if no match. Pick the best category_id from the results.
4. Call draft_listing with ALL fields: name, description, category_id, category_path, price (from caption), stock (ask if missing), weight in kg (default 0.5 if not mentioned).
5. Wait for the seller's explicit yes/confirm/ok.
6. Call create_listing to post it live.

If upload_product_image fails, tell the user the exact error. Do not keep retrying silently.

Rules:
- Use tools to fetch real data before answering. Never make up numbers.
- Be concise — this is Telegram, not email. Keep replies short and scannable.
- Use plain text only (no markdown **bold** or _italic_ — Telegram plain text mode).
- For SENSITIVE actions (listing, voucher, replies): always show a preview and ask for confirmation first. Never execute without explicit seller approval.
- If the seller says "yes", "confirm", "do it", "go ahead", "post it" — check conversation history to understand what they're confirming.
- If unsure what the seller wants, ask a short clarifying question.`;

// ── Manager Agent ─────────────────────────────────────────────────────────────

export class ManagerAgent {
  private history: Array<{ role: "user" | "assistant"; content: string | ContentBlock[] }> = [];
  private readonly maxHistory = 20; // turns (pairs)
  readonly activityLog: ActivityEntry[] = [];
  private readonly maxActivityLog = 50;
  private pendingImageBase64: string | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly adapter: Platform,
    private readonly audit: AuditLog,
    private readonly config: Config,
  ) {}

  async chatWithImage(userMessage: string, imageBase64: string, mimeType: string): Promise<string> {
    this.pendingImageBase64 = imageBase64;
    // Build a multimodal first message
    const content = [
      {
        type: "image" as const,
        source: { type: "base64" as const, media_type: mimeType as "image/jpeg", data: imageBase64 },
      },
      {
        type: "text" as const,
        text: userMessage || "I want to list this product on Shopee. Please analyse the photo and help me create a listing.",
      },
    ];
    this.history.push({ role: "user", content: content as unknown as ContentBlock[] });
    if (this.history.length > this.maxHistory * 2) {
      this.history = this.history.slice(-this.maxHistory * 2);
    }
    try {
      return await this.runAgentLoop();
    } catch (err) {
      logger.error("manager agent error", { error: (err as Error).message });
      return `Sorry, something went wrong: ${(err as Error).message}`;
    }
  }

  async chat(userMessage: string): Promise<string> {
    // Add user message to history
    this.history.push({ role: "user", content: userMessage });

    // Trim history to avoid token bloat
    if (this.history.length > this.maxHistory * 2) {
      this.history = this.history.slice(-this.maxHistory * 2);
    }

    try {
      return await this.runAgentLoop();
    } catch (err) {
      logger.error("manager agent error", { error: (err as Error).message });
      return `Sorry, something went wrong: ${(err as Error).message}`;
    }
  }

  private async runAgentLoop(): Promise<string> {
    let response = await this.callClaude(this.history);
    let iterations = 0;
    const maxIterations = 5; // prevent infinite loops

    while (response.stop_reason === "tool_use" && iterations < maxIterations) {
      iterations++;
      const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];

      for (const toolUse of toolUses) {
        logger.info("manager agent: tool call", { tool: toolUse.name, input: toolUse.input });
        let result: string;
        const toolCtx: ToolContext = { pendingImageBase64: this.pendingImageBase64 ?? undefined };
        try {
          result = await executeTool(toolUse.name, toolUse.input, this.adapter, this.audit, this.config, toolCtx);
          // Clear pending image after a successful listing creation
          if (toolUse.name === "create_listing" && !result.startsWith("Error")) {
            this.pendingImageBase64 = null;
          }
        } catch (err) {
          result = `Error: ${(err as Error).message}`;
        }

        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
        this.recordActivity(toolUse.name, result);
      }

      // Append assistant response + tool results
      this.history.push({ role: "assistant", content: response.content });
      this.history.push({ role: "user", content: toolResults as unknown as string });

      response = await this.callClaude(this.history);
    }

    // Extract final text
    const text = response.content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    this.history.push({ role: "assistant", content: text });
    return text || "Done.";
  }

  private async callClaude(
    messages: Array<{ role: "user" | "assistant"; content: string | ContentBlock[] | unknown }>,
  ): Promise<AnthropicResponse> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOL_DEFINITIONS,
        messages,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic API ${res.status}: ${body}`);
    }

    return res.json() as Promise<AnthropicResponse>;
  }

  private recordActivity(toolName: string, result: string): void {
    const agent = SHOPEE_TOOLS.has(toolName) ? "shopee" : "marketing";
    const summary = result.split("\n")[0]?.slice(0, 100) ?? "";
    this.activityLog.unshift({ ts: new Date().toISOString(), agent, tool: toolName, summary });
    if (this.activityLog.length > this.maxActivityLog) {
      this.activityLog.length = this.maxActivityLog;
    }
  }

  clearHistory(): void {
    this.history = [];
  }

  get isAvailable(): boolean {
    return !!this.apiKey;
  }
}
