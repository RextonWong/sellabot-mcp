import cron from "node-cron";
import { loadConfig } from "./config.js";
import { InstagramClient } from "./platforms/instagram/client.js";
import { ManagerAgent } from "./agents/manager.js";
import { createTelegramBot } from "./telegram/bot.js";
import { logger } from "./core/logger.js";
import type { Platform } from "./core/platform.js";
import { runOrderMonitor } from "./routines/order-monitor.js";
import { runMorningBriefing } from "./routines/morning-briefing.js";
import { runEveningReport } from "./routines/evening-report.js";
import { runPromotions } from "./routines/promotions.js";
import { runAdGenerator } from "./routines/ad-generator.js";
import {
  bootstrapAdapter,
  bootstrapAudit,
  isBusinessHours,
  loadState,
  saveState,
  NotificationDispatcher,
  type RoutineState,
} from "./routines/shared.js";

const config = loadConfig();
if (!config.daemon) {
  console.error(
    "Daemon config missing. Set NOTIFY_EMAIL, SMTP_USER, SMTP_PASS in .env to enable the daemon.",
  );
  process.exit(1);
}

logger.setLevel(config.server.logLevel);

const daemonCfg = config.daemon;
const tz = daemonCfg.timezone;
const adapter: Platform = bootstrapAdapter(config);
const audit = bootstrapAudit(config);
const notifier = new NotificationDispatcher(daemonCfg);

const instagramClient =
  daemonCfg.instagramAccessToken && daemonCfg.instagramUserId
    ? new InstagramClient(daemonCfg.instagramAccessToken, daemonCfg.instagramUserId)
    : undefined;
let state: RoutineState = loadState();
let running = false;

async function withErrorBoundary(
  name: keyof RoutineState,
  fn: () => Promise<void>,
): Promise<void> {
  if (running) {
    logger.warn("skipping routine, previous run still active", { routine: name });
    return;
  }
  running = true;
  try {
    await fn();
    state[name].consecutiveFailures = 0;
  } catch (err) {
    state[name].consecutiveFailures += 1;
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`routine failed: ${name}`, { error: message, failures: state[name].consecutiveFailures });
    await notifier.sendPush(
      `Sellabot: ${name} failed`,
      `Error: ${message} (failure #${state[name].consecutiveFailures})`,
      true,
    );
  } finally {
    saveState(state);
    running = false;
  }
}

// ── Cron schedules ────────────────────────────────────────────────────────────

// Order monitor: every 30 min, business hours only
cron.schedule("*/30 * * * *", () => {
  if (!isBusinessHours(tz)) return;
  withErrorBoundary("orderMonitor", async () => {
    logger.info("running order monitor");
    const { result, updatedState } = await runOrderMonitor(adapter, state.orderMonitor, tz);
    state.orderMonitor = updatedState;
    if (result.urgent || (result.data as { new: number }).new > 0) {
      await notifier.dispatch(result);
    } else {
      logger.info("order monitor: nothing new to report");
    }
  });
});

// Morning briefing: daily at 00:00 UTC = 8:00 AM MYT
cron.schedule("0 0 * * *", () => {
  withErrorBoundary("morningBriefing", async () => {
    logger.info("running morning briefing");
    const { result, updatedState } = await runMorningBriefing(
      adapter,
      state.morningBriefing,
      tz,
      {
        lowStockThreshold: daemonCfg.lowStockThreshold,
        autoReplyReviews: daemonCfg.autoReplyReviews,
        autoAcceptUnpaidCancellations: daemonCfg.autoAcceptUnpaidCancellations,
        restockAlertDays: daemonCfg.restockAlertDays,
      },
      audit,
    );
    state.morningBriefing = updatedState;
    await notifier.dispatch(result);
  });
});

// Evening report: daily at 12:00 UTC = 8:00 PM MYT
cron.schedule("0 12 * * *", () => {
  withErrorBoundary("eveningReport", async () => {
    logger.info("running evening report");
    const { result, updatedState } = await runEveningReport(adapter, state.eveningReport, tz);
    state.eveningReport = updatedState;
    await notifier.dispatch(result);
  });
});

// Weekly: Sunday at 01:00 UTC = 9:00 AM MYT
// Runs promotions (voucher + boost) then the weekly ad pack
cron.schedule("0 1 * * 0", () => {
  if (daemonCfg.autoCreateVoucher || daemonCfg.autoBoostListings) {
    withErrorBoundary("promotions", async () => {
      logger.info("running weekly promotions");
      const result = await runPromotions(
        adapter,
        {
          autoCreateVoucher: daemonCfg.autoCreateVoucher,
          weeklyVoucherDiscount: daemonCfg.weeklyVoucherDiscount,
          autoBoostListings: daemonCfg.autoBoostListings,
          boostTopN: daemonCfg.boostTopN,
          boostProductIds: daemonCfg.boostProductIds,
          boostAutoExecute: daemonCfg.boostAutoExecute,
          timezone: tz,
        },
        audit,
      );
      state.promotions.lastRunAt = new Date().toISOString();
      await notifier.dispatch(result);
    });
  }

  if (daemonCfg.adGeneratorEnabled) {
    withErrorBoundary("adGenerator", async () => {
      logger.info("running weekly ad generator");
      const { result } = await runAdGenerator(adapter, {
        limit: daemonCfg.adProductsLimit,
        anthropicApiKey: config.anthropicApiKey,
        instagramClient,
        autoPostInstagram: daemonCfg.autoPostInstagram,
      });
      state.adGenerator.lastRunAt = new Date().toISOString();
      await notifier.dispatch(result);
    });
  }
});

// ── Manager Agent + Telegram bot ─────────────────────────────────────────────

const managerAgent = config.anthropicApiKey
  ? new ManagerAgent(
      config.anthropicApiKey,
      "claude-haiku-4-5-20251001",
      adapter,
      audit,
      config,
    )
  : undefined;

if (managerAgent) {
  logger.info("manager agent ready", { model: "claude-haiku-4-5-20251001" });
}

if (daemonCfg.telegramBotToken && daemonCfg.telegramChatId) {
  const bot = createTelegramBot(
    daemonCfg.telegramBotToken,
    daemonCfg.telegramChatId,
    adapter,
    audit,
    config,
    managerAgent,
  );
  bot.start({ onStart: () => logger.info("telegram bot polling started") });
}

// ── Startup ───────────────────────────────────────────────────────────────────

const adMode = config.anthropicApiKey ? "AI (Claude Haiku)" : "templates";
console.error(`
╔══════════════════════════════════════════════╗
║         SELLABOT DAEMON — RUNNING           ║
╠══════════════════════════════════════════════╣
║  Timezone:  ${tz.padEnd(32)}║
║  Email:     ${daemonCfg.notifyEmail.padEnd(32)}║
║  Push:      ${(daemonCfg.ntfyTopic ? `ntfy.sh/${daemonCfg.ntfyTopic}` : "disabled").padEnd(32)}║
║  Telegram:  ${(daemonCfg.telegramBotToken ? "enabled" : "disabled").padEnd(32)}║
║  Manager Agent: ${(managerAgent ? "ON (free-text chat)" : "OFF — set ANTHROPIC_API_KEY").padEnd(28)}║
╠══════════════════════════════════════════════╣
║  PHASE 2                                    ║
║  Auto-reply reviews:  ${(daemonCfg.autoReplyReviews ? "ON" : "OFF").padEnd(22)}║
║  Auto-accept unpaid:  ${(daemonCfg.autoAcceptUnpaidCancellations ? "ON" : "OFF").padEnd(22)}║
║  Restock alert:       ${(`${daemonCfg.restockAlertDays} days`).padEnd(22)}║
╠══════════════════════════════════════════════╣
║  PHASE 3                                    ║
║  Auto-voucher:        ${(daemonCfg.autoCreateVoucher ? `ON (${daemonCfg.weeklyVoucherDiscount}% off)` : "OFF").padEnd(22)}║
║  Auto-boost:          ${(daemonCfg.autoBoostListings ? `ON (top ${daemonCfg.boostTopN})` : "OFF").padEnd(22)}║
║  Ad generator:        ${(daemonCfg.adGeneratorEnabled ? `ON — ${adMode}` : "OFF").padEnd(22)}║
║  Instagram posting:   ${(daemonCfg.autoPostInstagram && instagramClient ? "ON" : "OFF").padEnd(22)}║
╠══════════════════════════════════════════════╣
║  SCHEDULES (times in ${tz.slice(0, 10).padEnd(10)})          ║
║  • Order monitor:    every 30 min (8-22h)   ║
║  • Morning briefing: daily 8:00 AM          ║
║  • Evening report:   daily 8:00 PM          ║
║  • Promotions + Ads: Sunday 9:00 AM         ║
╠══════════════════════════════════════════════╣
║  Press Ctrl+C to stop                       ║
╚══════════════════════════════════════════════╝
`);

logger.info("daemon started", {
  timezone: tz,
  email: daemonCfg.notifyEmail,
  ntfy: daemonCfg.ntfyTopic ?? "disabled",
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown() {
  logger.info("daemon stopping");
  cron.getTasks().forEach((task) => task.stop());
  saveState(state);
  console.error("\nSellabot daemon stopped.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
