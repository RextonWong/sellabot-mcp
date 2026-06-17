import { z } from "zod";
import { mutationTool, pageSchema, readTool, type ToolContext } from "./helpers.js";

/**
 * Returns, cancellations & disputes. Every `respond_*` here is CRITICAL: it
 * touches money or shop reputation and is always gated on the seller's explicit
 * yes (CLAUDE.md §3). Claude's job: read the case, explain it, recommend, wait.
 */
export function registerReturnTools(ctx: ToolContext) {
  // ── Returns / refunds ────────────────────────────────────────────────--
  readTool(ctx, {
    name: "get_returns",
    title: "Get returns",
    description: "List buyer return/refund requests.",
    capability: "returns",
    schema: {
      status: z.enum(["pending", "accepted", "rejected", "closed"]).optional(),
      ...pageSchema,
    },
    handler: (a, platform) =>
      platform.getReturns({ status: a.status, limit: a.limit, cursor: a.cursor }),
  });

  readTool(ctx, {
    name: "get_return",
    title: "Get return",
    description: "Full detail of one return/refund request: reason, evidence, amount, buyer.",
    capability: "returns",
    schema: { return_id: z.string() },
    handler: (a, platform) => platform.getReturn({ returnId: a.return_id }),
  });

  mutationTool(ctx, {
    name: "respond_to_return",
    title: "Respond to return",
    description:
      "Accept or reject a return/refund request (optionally a partial amount). Always requires the seller's explicit approval.",
    tier: "CRITICAL",
    capability: "returns",
    schema: {
      return_id: z.string(),
      decision: z.enum(["accept", "reject"]),
      refund_amount: z.number().positive().optional(),
      currency: z.string().optional(),
      reason: z.string().optional(),
    },
    effect: (a) =>
      `${a.decision === "accept" ? "ACCEPT" : "REJECT"} return ${a.return_id}` +
      (a.refund_amount ? ` with refund ${a.refund_amount}` : "") +
      (a.reason ? ` (reason: ${a.reason})` : "") +
      ".",
    handler: (a, platform) =>
      platform.respondToReturn({
        returnId: a.return_id,
        decision: a.decision,
        refundAmount: a.refund_amount
          ? { amount: a.refund_amount, currency: a.currency ?? "" }
          : undefined,
        reason: a.reason,
      }),
  });

  // ── Cancellations ────────────────────────────────────────────────────--
  readTool(ctx, {
    name: "get_cancellations",
    title: "Get cancellations",
    description: "List buyer-initiated cancellation requests.",
    capability: "orders",
    schema: { status: z.string().optional(), ...pageSchema },
    handler: (a, platform) =>
      platform.getCancellations({ status: a.status, limit: a.limit, cursor: a.cursor }),
  });

  mutationTool(ctx, {
    name: "respond_to_cancellation",
    title: "Respond to cancellation",
    description:
      "Accept or reject a buyer's cancellation request. Always requires the seller's explicit approval.",
    tier: "CRITICAL",
    capability: "orders",
    schema: {
      cancellation_id: z.string(),
      decision: z.enum(["accept", "reject"]),
      reason: z.string().optional(),
    },
    effect: (a) =>
      `${a.decision === "accept" ? "ACCEPT" : "REJECT"} cancellation ${a.cancellation_id}.`,
    handler: (a, platform) =>
      platform.respondToCancellation({
        cancellationId: a.cancellation_id,
        decision: a.decision,
        reason: a.reason,
      }),
  });

  // ── Disputes / complaints ────────────────────────────────────────────--
  readTool(ctx, {
    name: "get_disputes",
    title: "Get disputes",
    description: "List disputes/complaints/escalations needing seller input.",
    capability: "disputes",
    schema: { status: z.string().optional(), ...pageSchema },
    handler: (a, platform) =>
      platform.getDisputes({ status: a.status, limit: a.limit, cursor: a.cursor }),
  });

  mutationTool(ctx, {
    name: "respond_to_dispute",
    title: "Respond to dispute",
    description:
      "Submit the seller's response/evidence to a dispute or complaint. Always requires the seller's explicit approval.",
    tier: "CRITICAL",
    capability: "disputes",
    schema: {
      dispute_id: z.string(),
      message: z.string(),
      evidence: z.array(z.string()).optional(),
      proposed_resolution: z.string().optional(),
    },
    effect: (a) =>
      `Respond to dispute ${a.dispute_id}: "${a.message.slice(0, 80)}"` +
      (a.proposed_resolution ? ` (proposed: ${a.proposed_resolution})` : "") +
      ".",
    handler: (a, platform) =>
      platform.respondToDispute({
        disputeId: a.dispute_id,
        message: a.message,
        evidence: a.evidence,
        proposedResolution: a.proposed_resolution,
      }),
  });
}
