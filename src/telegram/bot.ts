import { Bot } from "grammy";
import type { AuditLog } from "../core/audit.js";
import type { Platform } from "../core/platform.js";
import type { Config } from "../config.js";
import { runMorningBriefing } from "../routines/morning-briefing.js";
import { runEveningReport } from "../routines/evening-report.js";
import { loadState, saveState, type RoutineState } from "../routines/shared.js";

const HELP_TEXT = `<b>Sellabot Commands</b>

/status — daemon health &amp; last run times
/briefing — run morning briefing now
/report — run evening report now
/orders — orders waiting to ship
/lowstock — products running low
/messages — unread buyer messages
/help — this message`;

function localTime(iso: string | null, tz: string): string {
  if (!iso) return "never";
  return new Intl.DateTimeFormat("en-MY", {
    timeZone: tz, dateStyle: "short", timeStyle: "short",
  }).format(new Date(iso));
}

export function createTelegramBot(
  token: string,
  allowedChatId: string,
  adapter: Platform,
  audit: AuditLog,
  config: Config,
): Bot {
  const daemonCfg = config.daemon!;
  const tz = daemonCfg.timezone;
  const bot = new Bot(token);

  // Silently reject all users except the authorized one
  bot.use(async (ctx, next) => {
    if (ctx.from?.id.toString() !== allowedChatId) return;
    await next();
  });

  bot.command(["start", "help"], async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: "HTML" });
  });

  bot.command("status", async (ctx) => {
    const state = loadState();
    const rows: Array<[string, keyof RoutineState]> = [
      ["Order Monitor",    "orderMonitor"],
      ["Morning Briefing", "morningBriefing"],
      ["Evening Report",   "eveningReport"],
      ["Promotions",       "promotions"],
      ["Ad Generator",     "adGenerator"],
    ];
    const lines = ["<b>Daemon Status</b>\n"];
    for (const [label, key] of rows) {
      const e = state[key];
      const t = localTime(e.lastRunAt, tz);
      const f = e.consecutiveFailures > 0 ? ` ⚠️ ${e.consecutiveFailures} fail(s)` : " ✅";
      lines.push(`${label}: ${t}${f}`);
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("briefing", async (ctx) => {
    await ctx.reply("Running morning briefing...");
    try {
      const state = loadState();
      const { result, updatedState } = await runMorningBriefing(
        adapter,
        state.morningBriefing,
        tz,
        {
          lowStockThreshold: daemonCfg.lowStockThreshold,
          autoReplyReviews: false,                   // no auto-actions on manual trigger
          autoAcceptUnpaidCancellations: false,
          restockAlertDays: daemonCfg.restockAlertDays,
        },
        audit,
      );
      state.morningBriefing = updatedState;
      saveState(state);
      await ctx.reply(result.summary.slice(0, 4000));
    } catch (err) {
      await ctx.reply(`Error: ${(err as Error).message}`);
    }
  });

  bot.command("report", async (ctx) => {
    await ctx.reply("Running evening report...");
    try {
      const state = loadState();
      const { result, updatedState } = await runEveningReport(adapter, state.eveningReport, tz);
      state.eveningReport = updatedState;
      saveState(state);
      await ctx.reply(result.summary.slice(0, 4000));
    } catch (err) {
      await ctx.reply(`Error: ${(err as Error).message}`);
    }
  });

  bot.command("orders", async (ctx) => {
    await ctx.reply("Checking orders...");
    try {
      const page = await adapter.getOrders({ status: "to_ship", limit: 10 });
      if (page.items.length === 0) {
        await ctx.reply("No orders waiting to ship. 🎉");
        return;
      }
      const lines = [`<b>${page.items.length} order(s) to ship:</b>\n`];
      for (const o of page.items) {
        const total = o.total ? `${o.total.currency} ${o.total.amount.toFixed(2)}` : "";
        lines.push(`• #${o.orderId} — ${o.buyerName} ${total}`);
      }
      await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
    } catch (err) {
      await ctx.reply(`Error: ${(err as Error).message}`);
    }
  });

  bot.command("lowstock", async (ctx) => {
    await ctx.reply("Checking stock...");
    try {
      const page = await adapter.getLowStockItems({
        threshold: daemonCfg.lowStockThreshold,
        limit: 20,
      });
      if (page.items.length === 0) {
        await ctx.reply("All products have sufficient stock. ✅");
        return;
      }
      const lines = [`<b>${page.items.length} low-stock item(s):</b>\n`];
      for (const s of page.items) {
        lines.push(`• ${s.name} — ${s.stock ?? 0} left`);
      }
      await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
    } catch (err) {
      await ctx.reply(`Error: ${(err as Error).message}`);
    }
  });

  bot.command("messages", async (ctx) => {
    await ctx.reply("Checking messages...");
    try {
      const page = await adapter.getMessages({ status: "unread", limit: 10 });
      if (page.items.length === 0) {
        await ctx.reply("No unread messages. ✅");
        return;
      }
      const lines = [`<b>${page.items.length} unread message(s):</b>\n`];
      for (const m of page.items) {
        const preview = m.lastMessage.slice(0, 80);
        lines.push(`• ${m.buyerName}: "${preview}"`);
      }
      await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
    } catch (err) {
      await ctx.reply(`Error: ${(err as Error).message}`);
    }
  });

  bot.on("message", async (ctx) => {
    await ctx.reply("Use /help to see available commands.");
  });

  return bot;
}
