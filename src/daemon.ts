import cron from "node-cron";
import { loadConfig } from "./config.js";
import { logger } from "./core/logger.js";
import type { Platform } from "./core/platform.js";
import { runOrderMonitor } from "./routines/order-monitor.js";

import { runMorningBriefing } from "./routines/morning-briefing.js";
import { runEveningReport } from "./routines/evening-report.js";
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

// ── Startup ───────────────────────────────────────────────────────────────────

console.error(`
╔══════════════════════════════════════════════╗
║         SELLABOT DAEMON — RUNNING           ║
╠══════════════════════════════════════════════╣
║  Timezone:  ${tz.padEnd(32)}║
║  Email:     ${daemonCfg.notifyEmail.padEnd(32)}║
║  Push:      ${(daemonCfg.ntfyTopic ? `ntfy.sh/${daemonCfg.ntfyTopic}` : "disabled").padEnd(32)}║
║  Auto-reply reviews: ${(daemonCfg.autoReplyReviews ? "ON" : "OFF").padEnd(23)}║
║  Auto-accept unpaid:  ${(daemonCfg.autoAcceptUnpaidCancellations ? "ON" : "OFF").padEnd(22)}║
║  Restock alert:  ${(`${daemonCfg.restockAlertDays} days`).padEnd(27)}║
╠══════════════════════════════════════════════╣
║  SCHEDULES (times in ${tz.slice(0, 10).padEnd(10)})          ║
║  • Order monitor:    every 30 min (8-22h)   ║
║  • Morning briefing: daily 8:00 AM          ║
║  • Evening report:   daily 8:00 PM          ║
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
