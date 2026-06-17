/**
 * Human-in-the-loop consent gate (CLAUDE.md §3).
 *
 * Design principle: Claude proposes, the seller disposes. Mutating actions at
 * SENSITIVE+ never execute without a distinct, explicit human approval of the
 * concrete effect. Enforcement lives HERE on the server — we never assume the
 * client UI happened to ask.
 *
 * Mechanism: "preview -> confirm -> execute".
 *   1. Primary path: MCP elicitation (server asks the seller directly).
 *   2. Fallback (client can't elicit): a short-lived confirmation token the
 *      model echoes back on a second call.
 *
 * This module is MCP-agnostic; the server injects an `Elicitor`.
 */
import { randomUUID } from "node:crypto";
import type { AuditLog } from "./audit.js";

export type RiskTier = "READ" | "ROUTINE" | "SENSITIVE" | "CRITICAL";

export interface ConfirmRequest {
  tool: string;
  tier: RiskTier;
  /** Concrete, human-readable description of exactly what will happen. */
  effect: string;
  details?: unknown;
}

export type ConfirmResult = "approved" | "declined" | "unsupported";

export interface Question {
  field: string;
  prompt: string;
  options?: string[];
}

/** Bridge to the MCP client for human interaction. Implemented in the server. */
export interface Elicitor {
  /** Ask the seller to approve a concrete action. */
  confirm(req: ConfirmRequest): Promise<ConfirmResult>;
  /** Ask the seller to fill in missing/ambiguous inputs. */
  ask(questions: Question[]): Promise<Record<string, string> | "unsupported" | "declined">;
}

export type GateResult<T> =
  | { status: "executed"; value: T }
  | { status: "declined" }
  | { status: "needs_confirmation"; token: string; effect: string };

export interface ConsentConfig {
  autoConfirmTier: "none" | "routine";
  bulkConfirmThreshold: number;
}

interface PendingConfirmation {
  fingerprint: string;
  expiresAt: number;
}

const TOKEN_TTL_MS = 5 * 60 * 1000;

export class ConsentGate {
  private pending = new Map<string, PendingConfirmation>();

  constructor(
    private config: ConsentConfig,
    private elicitor: Elicitor,
    private audit: AuditLog,
  ) {}

  private requiresConfirmation(tier: RiskTier): boolean {
    switch (tier) {
      case "READ":
        return false;
      case "ROUTINE":
        return this.config.autoConfirmTier !== "routine";
      case "SENSITIVE":
      case "CRITICAL":
        return true; // never auto-confirmable
    }
  }

  /** Stable fingerprint for matching a confirmation token to its exact action. */
  private fingerprint(req: ConfirmRequest): string {
    return `${req.tool}::${req.effect}`;
  }

  private sweep() {
    const now = Date.now();
    for (const [token, p] of this.pending) {
      if (p.expiresAt < now) this.pending.delete(token);
    }
  }

  /**
   * Run `execute` only with the appropriate consent for `req.tier`.
   * `confirmationToken` is the optional token echoed back by the model on a
   * second call (used only when the client can't elicit).
   */
  async run<T>(
    req: ConfirmRequest,
    execute: () => Promise<T>,
    confirmationToken?: string,
  ): Promise<GateResult<T>> {
    if (!this.requiresConfirmation(req.tier)) {
      const value = await execute();
      this.audit.record({
        tool: req.tool,
        tier: req.tier,
        effect: req.effect,
        decision: req.tier === "READ" ? "not_required" : "auto",
        outcome: "executed",
      });
      return { status: "executed", value };
    }

    // Token fallback: a valid, matching token means the seller already approved.
    if (confirmationToken) {
      this.sweep();
      const p = this.pending.get(confirmationToken);
      if (p && p.fingerprint === this.fingerprint(req)) {
        this.pending.delete(confirmationToken);
        return this.execApproved(req, execute, "approved");
      }
      // stale/mismatched token -> fall through and ask again
    }

    // Primary path: ask the seller via elicitation.
    const result = await this.elicitor.confirm(req);
    if (result === "approved") {
      return this.execApproved(req, execute, "approved");
    }
    if (result === "declined") {
      this.audit.record({
        tool: req.tool,
        tier: req.tier,
        effect: req.effect,
        decision: "declined",
        outcome: "declined",
      });
      return { status: "declined" };
    }

    // Client can't elicit -> issue a token and ask the model to re-call.
    const token = randomUUID();
    this.pending.set(token, {
      fingerprint: this.fingerprint(req),
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });
    return { status: "needs_confirmation", token, effect: req.effect };
  }

  private async execApproved<T>(
    req: ConfirmRequest,
    execute: () => Promise<T>,
    decision: "approved",
  ): Promise<GateResult<T>> {
    try {
      const value = await execute();
      this.audit.record({
        tool: req.tool,
        tier: req.tier,
        effect: req.effect,
        decision,
        outcome: "executed",
      });
      return { status: "executed", value };
    } catch (err) {
      this.audit.record({
        tool: req.tool,
        tier: req.tier,
        effect: req.effect,
        decision,
        outcome: "error",
        error: (err as Error).message,
      });
      throw err;
    }
  }
}
