import { loadConfig } from "../src/config.js";
import { bootstrapAdapter, bootstrapAudit, NotificationDispatcher } from "../src/routines/shared.js";
import { runMorningBriefing } from "../src/routines/morning-briefing.js";

async function main() {
  console.log("Loading config...");
  const config = loadConfig();

  if (!config.daemon) {
    console.error("No daemon config found. Set NOTIFY_EMAIL in .env");
    process.exit(1);
  }

  console.log("Bootstrapping adapter...");
  const adapter = bootstrapAdapter(config);
  const audit = bootstrapAudit(config);
  const notifier = new NotificationDispatcher(config.daemon);
  const tz = config.daemon.timezone;

  console.log("Running morning briefing...\n");
  const { result } = await runMorningBriefing(
    adapter,
    { lastRunAt: null, knownOrderIds: [], consecutiveFailures: 0 },
    tz,
    {
      lowStockThreshold: config.daemon.lowStockThreshold,
      autoReplyReviews: config.daemon.autoReplyReviews,
      autoAcceptUnpaidCancellations: config.daemon.autoAcceptUnpaidCancellations,
      restockAlertDays: config.daemon.restockAlertDays,
    },
    audit,
  );

  console.log(result.summary);
  console.log("\n--- Sending notifications ---");
  await notifier.dispatch(result);
  console.log("Done! Check your email and ntfy app.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
