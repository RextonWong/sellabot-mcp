/**
 * Structured logger that writes to STDERR only.
 *
 * stdout is the MCP stdio transport — writing anything there corrupts the
 * protocol. Every log line is JSON with secrets redacted.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SECRET_KEYS = [
  "partner_key",
  "partnerKey",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "sign",
  "authorization",
  "token_encryption_key",
  "tokenEncryptionKey",
  "password",
  "secret",
];

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.some((s) => k.toLowerCase() === s.toLowerCase())) {
        out[k] = "[redacted]";
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export class Logger {
  constructor(private level: LogLevel = "info") {}

  setLevel(level: LogLevel) {
    this.level = level;
  }

  private write(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    process.stderr.write(JSON.stringify(line) + "\n");
  }

  debug(msg: string, fields?: Record<string, unknown>) {
    this.write("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>) {
    this.write("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>) {
    this.write("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>) {
    this.write("error", msg, fields);
  }
}

/** Shared default logger; level is reset from config at startup. */
export const logger = new Logger((process.env.LOG_LEVEL as LogLevel) || "info");
