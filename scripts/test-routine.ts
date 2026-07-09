/**
 * Manual test harness — runs one routine immediately and sends notifications.
 * Usage: npx tsx scripts/test-routine.ts [routine]
 * Routines: briefing (default) | evening | promotions | ads
 */
import { loadConfig } from "../src/config.js";
import { bootstrapAdapter, bootstrapAudit, NotificationDispatcher } from "../src/routines/shared.js";
import { runMorningBriefing } from "../src/routines/morning-briefing.js";
import { runEveningReport } from "../src/routines/evening-report.js";
import { runPromotions } from "../src/routines/promotions.js";
import { runAdGenerator } from "../src/routines/ad-generator.js";

async function main() {
  const routine = process.argv[2] ?? "briefing";
  console.log(`Loading config... (routine: ${routine})`);
  const config = loadConfig();

  if (!config.daemon) {
    console.error("No daemon config found. Set NOTIFY_EMAIL in .env");
    process.exit(1);
  }

  const adapter = bootstrapAdapter(config);
  const audit = bootstrapAudit(config);
  const notifier = new NotificationDispatcher(config.daemon);
  const d = config.daemon;
  const tz = d.timezone;
  const emptyState = { lastRunAt: null, knownOrderIds: [], consecutiveFailures: 0 };

  if (routine === "briefing") {
    console.log("Running morning briefing...\n");
    const { result } = await runMorningBriefing(
      adapter,
      emptyState,
      tz,
      {
        lowStockThreshold: d.lowStockThreshold,
        autoReplyReviews: d.autoReplyReviews,
        autoAcceptUnpaidCancellations: d.autoAcceptUnpaidCancellations,
        restockAlertDays: d.restockAlertDays,
      },
      audit,
    );
    console.log(result.summary);
    console.log("\n--- Sending notifications ---");
    await notifier.dispatch(result);
  } else if (routine === "evening") {
    console.log("Running evening report...\n");
    const { result } = await runEveningReport(adapter, emptyState, tz);
    console.log(result.summary);
    console.log("\n--- Sending notifications ---");
    await notifier.dispatch(result);
  } else if (routine === "promotions") {
    console.log("Running weekly promotions...\n");
    const result = await runPromotions(
      adapter,
      {
        autoCreateVoucher: d.autoCreateVoucher,
        weeklyVoucherDiscount: d.weeklyVoucherDiscount,
        autoBoostListings: d.autoBoostListings,
        boostTopN: d.boostTopN,
        boostProductIds: d.boostProductIds,
        boostAutoExecute: d.boostAutoExecute,
        timezone: tz,
      },
      audit,
    );
    console.log(result.summary);
    console.log("\n--- Sending notifications ---");
    await notifier.dispatch(result);
  } else if (routine === "ads") {
    console.log("Running weekly ad generator...\n");
    const { result } = await runAdGenerator(adapter, {
      limit: d.adProductsLimit,
      anthropicApiKey: config.anthropicApiKey,
    });
    console.log(result.summary);
    console.log("\n--- Sending notifications ---");
    await notifier.dispatch(result);
  } else {
    console.error(`Unknown routine: ${routine}`);
    console.error("Usage: npx tsx scripts/test-routine.ts [briefing|evening|promotions|ads]");
    process.exit(1);
  }

  console.log("Done! Check your email and ntfy app.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
