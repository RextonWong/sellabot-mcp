/**
 * npm run status — prints a formatted summary of daemon health and audit history.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, ".data", "routine-state.json");
const AUDIT_PATH = resolve(ROOT, ".data", "audit.log");
const TZ = process.env.TIMEZONE ?? "Asia/Kuala_Lumpur";

// ── Helpers ───────────────────────────────────────────────────────────────────

function localTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  return new Intl.DateTimeFormat("en-MY", {
    timeZone: TZ,
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

const RESET = "\x1b[0m";
const BOLD  = "\x1b[1m";
const DIM   = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED   = "\x1b[31m";
const CYAN  = "\x1b[36m";

// ── Routine state ─────────────────────────────────────────────────────────────

interface StateEntry {
  lastRunAt: string | null;
  consecutiveFailures: number;
}

interface RoutineState {
  [key: string]: StateEntry;
}

const ROUTINE_LABELS: Record<string, string> = {
  orderMonitor:    "Order Monitor",
  morningBriefing: "Morning Briefing",
  eveningReport:   "Evening Report",
  messageMonitor:  "Message Monitor",
  promotions:      "Promotions",
  adGenerator:     "Ad Generator",
};

function printRoutineHealth(state: RoutineState) {
  console.log(`\n${BOLD}ROUTINE HEALTH${RESET}`);
  const border = "─".repeat(62);
  console.log(`┌${"─".repeat(22)}┬${"─".repeat(24)}┬${"─".repeat(13)}┐`);
  console.log(`│ ${BOLD}${pad("Routine", 20)}${RESET} │ ${BOLD}${pad("Last Run", 22)}${RESET} │ ${BOLD}${pad("Failures", 11)}${RESET} │`);
  console.log(`├${"─".repeat(22)}┼${"─".repeat(24)}┼${"─".repeat(13)}┤`);

  const order = ["orderMonitor", "morningBriefing", "eveningReport", "promotions", "adGenerator", "messageMonitor"];
  for (const key of order) {
    const entry = state[key];
    if (!entry) continue;
    const label = ROUTINE_LABELS[key] ?? key;
    const lastRun = localTime(entry.lastRunAt);
    const failures = entry.consecutiveFailures;
    const failStr = failures === 0
      ? `${GREEN}${pad("0", 11)}${RESET}`
      : failures >= 5
        ? `${RED}${pad(`${failures} ⚠`, 11)}${RESET}`
        : `${YELLOW}${pad(`${failures} ⚠`, 11)}${RESET}`;
    console.log(`│ ${pad(label, 20)} │ ${DIM}${pad(lastRun, 22)}${RESET} │ ${failStr} │`);
  }
  console.log(`└${"─".repeat(22)}┴${"─".repeat(24)}┴${"─".repeat(13)}┘`);
  void border;
}

// ── Audit log ─────────────────────────────────────────────────────────────────

interface AuditEntry {
  ts: string;
  tool: string;
  effect: string;
  decision: string;
  outcome: string;
  error?: string;
}

function printAuditLog(lines: string[], showLast = 15) {
  const entries: AuditEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      // skip malformed lines
    }
  }

  // Stats
  const executed = entries.filter((e) => e.outcome === "executed").length;
  const declined = entries.filter((e) => e.outcome === "declined").length;
  const errors   = entries.filter((e) => e.outcome === "error").length;

  console.log(`\n${BOLD}AUDIT SUMMARY${RESET}  (${entries.length} total entries)`);
  console.log(`  ${GREEN}✓ Executed: ${executed}${RESET}   ${YELLOW}✗ Declined: ${declined}${RESET}   ${RED}⚠ Errors: ${errors}${RESET}`);

  console.log(`\n${BOLD}RECENT ACTIONS${RESET}  (last ${Math.min(showLast, entries.length)} of ${entries.length})`);

  const recent = entries.slice(-showLast);
  if (recent.length === 0) {
    console.log(`  ${DIM}No actions recorded yet.${RESET}`);
    return;
  }

  for (const e of recent.reverse()) {
    const icon =
      e.outcome === "executed" ? `${GREEN}✓${RESET}` :
      e.outcome === "declined" ? `${YELLOW}✗${RESET}` :
                                  `${RED}⚠${RESET}`;
    const time = `${DIM}${localTime(e.ts)}${RESET}`;
    const tool = `${CYAN}${e.tool}${RESET}`;
    const effect = e.effect.length > 70 ? e.effect.slice(0, 67) + "…" : e.effect;
    console.log(`  ${icon} ${time}  ${tool}`);
    console.log(`      ${effect}`);
    if (e.error) console.log(`      ${RED}Error: ${e.error}${RESET}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const now = new Intl.DateTimeFormat("en-MY", {
  timeZone: TZ, dateStyle: "full", timeStyle: "short",
}).format(new Date());

console.log(`\n${BOLD}SELLABOT STATUS — ${now}${RESET}`);
console.log("═".repeat(62));

// Routine health
if (existsSync(STATE_PATH)) {
  const state = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as RoutineState;
  printRoutineHealth(state);
} else {
  console.log(`\n${YELLOW}No state file found. Has the daemon run yet?${RESET}`);
}

// Audit log
if (existsSync(AUDIT_PATH)) {
  const raw = readFileSync(AUDIT_PATH, "utf-8").trim().split("\n").filter(Boolean);
  printAuditLog(raw);
} else {
  console.log(`\n${DIM}No audit log yet — auto-actions will appear here once they run.${RESET}`);
}

console.log();
