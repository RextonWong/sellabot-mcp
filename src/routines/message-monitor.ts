import type { Platform } from "../core/platform.js";
import type { RoutineResult, RoutineStateEntry } from "./shared.js";
import { formatDate } from "./shared.js";

export async function runMessageMonitor(
  adapter: Platform,
  state: RoutineStateEntry,
  tz: string,
): Promise<{ result: RoutineResult; updatedState: RoutineStateEntry }> {
  const convos = await adapter.getMessages({ status: "unread", limit: 50 });

  const lines: string[] = [`MESSAGE MONITOR — ${formatDate(new Date().toISOString(), tz)}`, ""];

  lines.push(`UNREAD CONVERSATIONS (${convos.items.length}):`);
  if (convos.items.length === 0) {
    lines.push("  None — all caught up!");
  } else {
    for (const [i, c] of convos.items.entries()) {
      const preview = c.lastMessage.length > 80 ? c.lastMessage.slice(0, 77) + "..." : c.lastMessage;
      lines.push(`  ${i + 1}. ${c.buyerName} (${formatDate(c.updatedAt, tz)}): "${preview}"`);
    }
  }

  lines.push("");
  lines.push(`Summary: ${convos.items.length} unread conversation${convos.items.length === 1 ? "" : "s"} need${convos.items.length === 1 ? "s" : ""} your attention.`);

  return {
    result: {
      name: "Message Monitor",
      summary: lines.join("\n"),
      urgent: convos.items.length > 0,
      data: { unread: convos.items.length },
    },
    updatedState: {
      lastRunAt: new Date().toISOString(),
      knownOrderIds: state.knownOrderIds,
      consecutiveFailures: 0,
    },
  };
}
