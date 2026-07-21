/**
 * Operating Agent — the shop-operations specialist.
 *
 * Handles day-to-day Shopee operations delegated by the Manager: orders, stock,
 * messages, reviews, returns, shop performance, and creating product listings
 * (including analysing a product photo with vision).
 *
 * Keeps its own conversation history so multi-step flows (photo → draft →
 * "yes post it") survive across delegations.
 */
import type { Platform } from "../core/platform.js";
import type { AuditLog } from "../core/audit.js";
import type { Config } from "../config.js";
import { OPERATING_TOOL_DEFS, executeTool, type ToolContext } from "./tools.js";
import { runAgentLoop, type Message, type ActivityTracker } from "./runtime.js";

const SYSTEM_PROMPT = `You are the Operating Agent for a Shopee seller's store in Malaysia.
You handle day-to-day shop operations: orders, stock/inventory, buyer messages, reviews, returns, shop performance, and creating new product listings.

You receive tasks from the Manager Agent. Do the work with your tools and reply with a concise, plain-text result the Manager can relay to the seller. No markdown formatting.

CREATING A LISTING (when a product photo is provided):
1. Call upload_product_image first to upload the photo to Shopee's CDN.
2. Analyse the product from the image + caption — name, features, brand, selling points.
3. Call search_categories with a broad keyword (e.g. "kitchen", "electronics", "fashion", "beauty", "sports"). Pick the best LEAF category_id from the results.
4. Call draft_listing with ALL fields: name, description, category_id, category_path, price, stock, brand, weight_kg, and parcel dimensions (length_cm, width_cm, height_cm).
   - Brand: read it from the image/caption; use "No Brand" if none is visible.
   - Weight & dimensions: ESTIMATE realistic shipping values from the product type. Never leave blank. (e.g. water dispenser ~12kg 40x40x120cm; phone case ~0.1kg 20x15x3cm.)
5. Return the draft preview and STOP — wait for the seller to confirm via the Manager.
6. Only when the task tells you the seller confirmed, call create_listing with the SAME values.

Report the exact error if a tool fails — do not silently retry the same call.`;

export class OperatingAgent {
  private history: Message[] = [];
  private readonly maxHistory = 24; // messages
  private pendingImageBase64: string | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly adapter: Platform,
    private readonly audit: AuditLog,
    private readonly config: Config,
    private readonly tracker: ActivityTracker,
  ) {}

  /**
   * Handle one delegated task. If an image is supplied, it becomes available to
   * the upload_product_image tool and is attached to the message for vision.
   */
  async handle(task: string, imageBase64?: string, mimeType = "image/jpeg"): Promise<string> {
    if (imageBase64) this.pendingImageBase64 = imageBase64;

    if (imageBase64) {
      this.history.push({
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
          { type: "text", text: task },
        ],
      });
    } else {
      this.history.push({ role: "user", content: task });
    }
    this.trim();

    return runAgentLoop(
      {
        apiKey: this.apiKey,
        model: this.model,
        system: SYSTEM_PROMPT,
        tools: OPERATING_TOOL_DEFS,
        label: "operating agent",
        executeTool: async (name, input) => {
          const ctx: ToolContext = { pendingImageBase64: this.pendingImageBase64 ?? undefined };
          const result = await executeTool(name, input, this.adapter, this.audit, this.config, ctx);
          if (name === "create_listing" && !result.startsWith("Error")) {
            this.pendingImageBase64 = null;
          }
          return result;
        },
        onTool: (name, _input, result) => this.tracker.record("operating", name, result),
      },
      this.history,
    );
  }

  clearHistory(): void {
    this.history = [];
    this.pendingImageBase64 = null;
  }

  private trim(): void {
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
  }
}
