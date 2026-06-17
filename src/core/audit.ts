/**
 * Append-only audit log of every mutating attempt: the proposed effect, the
 * consent decision, and the outcome. Always emitted to stderr (structured);
 * optionally also appended to a file via AUDIT_LOG_PATH.
 *
 * Answers "what did the bot change, and who approved it?" after the fact.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "./logger.js";
import type { RiskTier } from "./consent.js";

export type ConsentDecision = "approved" | "declined" | "auto" | "not_required";
export type AuditOutcome = "executed" | "gated" | "declined" | "error";

export interface AuditEntry {
  tool: string;
  tier: RiskTier;
  /** Human-readable description of the concrete effect. */
  effect: string;
  decision: ConsentDecision;
  outcome: AuditOutcome;
  error?: string;
}

export class AuditLog {
  constructor(private filePath?: string) {
    if (filePath) mkdirSync(dirname(filePath), { recursive: true });
  }

  record(entry: AuditEntry): void {
    const line = { ts: new Date().toISOString(), kind: "audit", ...entry };
    logger.info("audit", line);
    if (this.filePath) {
      try {
        appendFileSync(this.filePath, JSON.stringify(line) + "\n");
      } catch (err) {
        logger.warn("audit file write failed", { error: (err as Error).message });
      }
    }
  }
}
