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
import type { TaskScheduler, ScheduledAgent, ScheduledTask } from "../routines/scheduler.js";
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
  {
    name: "schedule_task",
    description:
      "Create a RECURRING scheduled task (e.g. 'boost these products every day at 9am'). The task runs automatically on the cron schedule and reports back to the seller. Use this when the seller asks for anything repeating ('every day', 'each morning', 'weekly', 'every hour').",
    input_schema: {
      type: "object",
      properties: {
        cron: {
          type: "string",
          description:
            "Standard 5-field cron expression interpreted in the shop timezone (Asia/Kuala_Lumpur). Examples: daily 9am = '0 9 * * *'; every Monday 8am = '0 8 * * 1'; every hour = '0 * * * *'; every day 9am and 6pm = use two separate tasks.",
        },
        agent: {
          type: "string",
          enum: ["operating", "promoting"],
          description: "Which specialist runs it: 'promoting' for boosting/vouchers, 'operating' for orders/stock/briefings.",
        },
        instruction: {
          type: "string",
          description:
            "Self-contained instruction the specialist runs each time, e.g. 'Boost the Cuckoo water dispenser and the rice cooker listings.' Include product names so the agent can find them.",
        },
        description: {
          type: "string",
          description: "Short human-readable label, e.g. 'Boost water dispenser + rice cooker daily 9am'.",
        },
      },
      required: ["cron", "agent", "instruction", "description"],
    },
  },
  {
    name: "list_scheduled_tasks",
    description: "List all recurring scheduled tasks the seller has set up, with their IDs.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "cancel_scheduled_task",
    description: "Cancel/delete a recurring scheduled task by its ID (get the ID from list_scheduled_tasks).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The scheduled task ID to cancel." },
      },
      required: ["id"],
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
- Relay the specialist's answer to the seller in concise, friendly plain text (no markdown). Do not invent data.

SCHEDULING (recurring tasks):
- When the seller asks for something REPEATING ("boost these every day", "each morning check...", "weekly voucher"), use schedule_task — do NOT delegate it as a one-off.
- Convert their timing to a 5-field cron expression in Malaysia time. Common: daily 9am='0 9 * * *', weekdays 8am='0 8 * * 1-5', every Monday='0 9 * * 1', every hour='0 * * * *', twice a day (9am+6pm)=create TWO tasks.
- Pick agent: 'promoting' for boost/voucher tasks, 'operating' for orders/stock/briefing tasks.
- Write a self-contained instruction (include product names) and a short description.
- After scheduling, confirm to the seller what will run and when. Note that scheduled promotion actions run automatically without asking each time (they approved it by scheduling).
- To review or stop schedules, use list_scheduled_tasks / cancel_scheduled_task.`;

export class ManagerAgent {
  private history: Message[] = [];
  private readonly maxHistory = 24;
  private pendingImageBase64: string | null = null;

  private readonly tracker = new ActivityTracker();
  private readonly operating: OperatingAgent;
  private readonly promoting: PromotingAgent;
  private scheduler: TaskScheduler | null = null;

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

  /** Wire the scheduler after construction (avoids a constructor cycle). */
  attachScheduler(scheduler: TaskScheduler): void {
    this.scheduler = scheduler;
  }

  /** Called by the scheduler when a recurring task fires. */
  runScheduledTask(agent: ScheduledAgent, instruction: string): Promise<string> {
    return agent === "promoting"
      ? this.promoting.runIsolated(instruction)
      : this.operating.runIsolated(instruction);
  }

  listSchedules(): ScheduledTask[] {
    return this.scheduler?.list() ?? [];
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
    if (name === "delegate_to_operations") {
      // Hand the pending image to operations once, then clear it here so it
      // isn't re-sent on later delegations.
      const image = this.pendingImageBase64 ?? undefined;
      this.pendingImageBase64 = null;
      return this.operating.handle((input.task as string) ?? "", image);
    }
    if (name === "delegate_to_promotions") {
      return this.promoting.handle((input.task as string) ?? "");
    }
    if (name === "schedule_task") return this.scheduleTask(input);
    if (name === "list_scheduled_tasks") return this.formatSchedules();
    if (name === "cancel_scheduled_task") return this.cancelTask(input.id as string);
    return `Unknown delegation: ${name}`;
  }

  private scheduleTask(input: Record<string, unknown>): string {
    if (!this.scheduler) return "Scheduling isn't available right now.";
    try {
      const task = this.scheduler.add({
        cron: input.cron as string,
        agent: (input.agent as ScheduledAgent) ?? "promoting",
        instruction: input.instruction as string,
        description: input.description as string,
      });
      return `Scheduled "${task.description}" (id: ${task.id}). It will run automatically on schedule and report back here.`;
    } catch (err) {
      return `Couldn't schedule that: ${(err as Error).message}`;
    }
  }

  private formatSchedules(): string {
    const tasks = this.scheduler?.list() ?? [];
    if (tasks.length === 0) return "No scheduled tasks set up.";
    return tasks
      .map((t) => `• ${t.description} [${t.agent}] (id: ${t.id}, cron: ${t.cron})`)
      .join("\n");
  }

  private cancelTask(id: string): string {
    if (!this.scheduler) return "Scheduling isn't available right now.";
    return this.scheduler.remove(id)
      ? `Cancelled scheduled task ${id}.`
      : `No scheduled task found with id ${id}.`;
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
