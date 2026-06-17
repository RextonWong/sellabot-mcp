import { z } from "zod";
import { mutationTool, pageSchema, readTool, type ToolContext } from "./helpers.js";

export function registerOrderTools(ctx: ToolContext) {
  readTool(ctx, {
    name: "get_orders",
    title: "Get orders",
    description: "List orders, optionally filtered by fulfillment status.",
    capability: "orders",
    schema: {
      status: z
        .enum(["unpaid", "to_ship", "shipped", "completed", "cancelled"])
        .optional(),
      since: z.string().optional().describe("ISO 8601 lower bound on order creation time."),
      ...pageSchema,
    },
    handler: (a, platform) =>
      platform.getOrders({ status: a.status, since: a.since, limit: a.limit, cursor: a.cursor }),
  });

  readTool(ctx, {
    name: "get_order",
    title: "Get order",
    description:
      "Full detail for one order: line items, buyer, ship-to address, totals, and status.",
    capability: "orders",
    schema: { order_id: z.string() },
    handler: (a, platform) => platform.getOrder({ orderId: a.order_id }),
  });

  readTool(ctx, {
    name: "get_shipping_info",
    title: "Get shipping info",
    description:
      "Shipping requirements for an order: carrier, pickup/drop-off, ship-by deadline, parcel specs, pickup address.",
    capability: "fulfillment",
    schema: { order_id: z.string() },
    handler: (a, platform) => platform.getShippingInfo({ orderId: a.order_id }),
  });

  readTool(ctx, {
    name: "track_shipment",
    title: "Track shipment",
    description: "Current tracking status and checkpoints for a shipped order.",
    capability: "fulfillment",
    schema: {
      order_id: z.string().optional(),
      tracking_number: z.string().optional(),
    },
    handler: (a, platform) =>
      platform.trackShipment({ orderId: a.order_id, trackingNumber: a.tracking_number }),
  });

  mutationTool(ctx, {
    name: "arrange_shipment",
    title: "Arrange shipment",
    description:
      "Book courier pickup or drop-off for an order. This is the digital step — the seller still physically hands over the parcel.",
    tier: "CRITICAL",
    capability: "fulfillment",
    schema: {
      order_id: z.string(),
      method: z.enum(["pickup", "dropoff"]),
      pickup_time: z.string().optional(),
    },
    effect: (a) => `Book ${a.method} shipment for order ${a.order_id}.`,
    handler: (a, platform) =>
      platform.arrangeShipment({
        orderId: a.order_id,
        method: a.method,
        pickupTime: a.pickup_time,
      }),
  });

  mutationTool(ctx, {
    name: "get_shipping_document",
    title: "Get shipping document",
    description: "Generate/fetch the shipping label (airway bill) for a confirmed shipment.",
    tier: "ROUTINE",
    capability: "fulfillment",
    schema: {
      order_id: z.string(),
      format: z.enum(["pdf", "thermal"]).optional(),
    },
    effect: (a) => `Generate shipping document for order ${a.order_id}.`,
    handler: (a, platform) =>
      platform.getShippingDocument({ orderId: a.order_id, format: a.format }),
  });
}
