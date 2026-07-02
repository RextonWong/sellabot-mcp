import { createTransport, type Transporter } from "nodemailer";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, shopeeHost } from "../config.js";
import type { Config } from "../config.js";
import { AuditLog } from "../core/audit.js";
import { HttpClient } from "../core/http.js";
import { logger } from "../core/logger.js";
import type { Money } from "../core/models.js";
import type { Platform } from "../core/platform.js";
import { SqliteTokenStore } from "../core/token-store.js";
import { createShopeeAdapter } from "../platforms/shopee/index.js";

// ── Routine result ────────────────────────────────────────────────────────────

export interface RoutineResult {
  name: string;
  summary: string;
  urgent: boolean;
  data: unknown;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

export function bootstrapAudit(config: Config): AuditLog {
  return new AuditLog(config.consent.auditLogPath);
}

export function bootstrapAdapter(config: Config): Platform {
  const http = new HttpClient({
    timeoutMs: config.server.requestTimeoutMs,
    maxRetries: config.server.maxRetries,
  });
  const tokens = new SqliteTokenStore(
    config.tokenStore.dbPath,
    config.tokenStore.encryptionKey,
  );
  return createShopeeAdapter(config, http, tokens);
}

// ── State persistence ─────────────────────────────────────────────────────────

const STATE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".data",
  "routine-state.json",
);

export interface RoutineStateEntry {
  lastRunAt: string | null;
  knownOrderIds: string[];
  consecutiveFailures: number;
}

export interface RoutineState {
  orderMonitor: RoutineStateEntry;
  messageMonitor: RoutineStateEntry;
  morningBriefing: RoutineStateEntry;
  eveningReport: RoutineStateEntry;
}

const EMPTY_ENTRY: RoutineStateEntry = {
  lastRunAt: null,
  knownOrderIds: [],
  consecutiveFailures: 0,
};

function defaultState(): RoutineState {
  return {
    orderMonitor: { ...EMPTY_ENTRY },
    messageMonitor: { ...EMPTY_ENTRY },
    morningBriefing: { ...EMPTY_ENTRY },
    eveningReport: { ...EMPTY_ENTRY },
  };
}

export function loadState(): RoutineState {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as RoutineState;
  } catch {
    return defaultState();
  }
}

export function saveState(state: RoutineState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ── Notifications ─────────────────────────────────────────────────────────────

export class NotificationDispatcher {
  private mailer: Transporter | null = null;
  private ntfyTopic: string | null = null;
  private toEmail: string;

  constructor(config: NonNullable<Config["daemon"]>) {
    this.toEmail = config.notifyEmail;
    this.ntfyTopic = config.ntfyTopic ?? null;

    this.mailer = createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
  }

  async sendEmail(subject: string, body: string): Promise<void> {
    if (!this.mailer) return;
    try {
      await this.mailer.sendMail({
        from: `"Sellabot" <${(this.mailer.options as { auth?: { user?: string } }).auth?.user ?? "sellabot"}>`,
        to: this.toEmail,
        subject,
        text: body,
      });
      logger.info("email sent", { subject });
    } catch (err) {
      logger.error("email send failed", { error: (err as Error).message });
    }
  }

  async sendPush(title: string, message: string, urgent: boolean): Promise<void> {
    if (!this.ntfyTopic) return;
    try {
      await fetch(`https://ntfy.sh/${this.ntfyTopic}`, {
        method: "POST",
        headers: {
          Title: title,
          Priority: urgent ? "high" : "default",
          Tags: urgent ? "warning" : "package",
        },
        body: message,
      });
      logger.info("push sent", { title });
    } catch (err) {
      logger.error("push send failed", { error: (err as Error).message });
    }
  }

  async dispatch(result: RoutineResult): Promise<void> {
    const prefix = result.urgent ? "[URGENT] " : "";
    const subject = `${prefix}Sellabot: ${result.name}`;

    await Promise.allSettled([
      this.sendEmail(subject, result.summary),
      this.sendPush(subject, result.summary.slice(0, 500), result.urgent),
    ]);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function isBusinessHours(tz: string): boolean {
  const now = new Date();
  const hour = parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(now),
    10,
  );
  return hour >= 8 && hour < 22;
}

export function formatMoney(m: Money | null | undefined): string {
  if (!m) return "N/A";
  return `${m.currency} ${m.amount.toFixed(2)}`;
}

export function formatDate(iso: string | undefined, tz: string): string {
  if (!iso) return "N/A";
  return new Intl.DateTimeFormat("en-MY", {
    timeZone: tz,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

export function nowInTz(tz: string): string {
  return new Intl.DateTimeFormat("en-MY", {
    timeZone: tz,
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date());
}

export function hoursUntil(iso: string): number {
  return (new Date(iso).getTime() - Date.now()) / (1000 * 60 * 60);
}
