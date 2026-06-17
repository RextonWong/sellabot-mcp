import { z } from "zod";
import { mutationTool, pageSchema, readTool, type ToolContext } from "./helpers.js";

export function registerProductTools(ctx: ToolContext) {
  readTool(ctx, {
    name: "get_products",
    title: "Get products",
    description: "List or search products in the shop, optionally filtered by status.",
    capability: "products",
    schema: {
      query: z.string().optional().describe("Search text to match product names."),
      status: z.enum(["live", "unlisted", "banned", "sold_out"]).optional(),
      ...pageSchema,
    },
    handler: (args, platform) =>
      platform.getProducts({
        query: args.query,
        status: args.status,
        limit: args.limit,
        cursor: args.cursor,
      }),
  });

  mutationTool(ctx, {
    name: "create_listing",
    title: "Create listing",
    description: "Create a new product listing in the shop.",
    tier: "SENSITIVE",
    capability: "products",
    schema: {
      name: z.string(),
      description: z.string(),
      category_id: z.string(),
      price: z.number().positive(),
      currency: z.string().optional(),
      stock: z.number().int().min(0),
      images: z.array(z.string()).describe("Image IDs/URLs as required by the platform."),
      weight_kg: z.number().positive().optional(),
    },
    effect: (a) => `Create new listing "${a.name}" at ${a.price} with stock ${a.stock}.`,
    handler: (a, platform) =>
      platform.createListing({
        name: a.name,
        description: a.description,
        categoryId: a.category_id,
        price: { amount: a.price, currency: a.currency ?? "" },
        stock: a.stock,
        images: a.images,
        weightKg: a.weight_kg,
      }),
  });

  mutationTool(ctx, {
    name: "update_listing",
    title: "Update listing",
    description: "Edit an existing listing's content (name, description, images, etc.).",
    tier: "SENSITIVE",
    capability: "products",
    schema: {
      product_id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      category_id: z.string().optional(),
      images: z.array(z.string()).optional(),
      weight_kg: z.number().positive().optional(),
    },
    effect: (a) => `Update listing ${a.product_id}.`,
    handler: (a, platform) =>
      platform.updateListing({
        productId: a.product_id,
        name: a.name,
        description: a.description,
        categoryId: a.category_id,
        images: a.images,
        weightKg: a.weight_kg,
      }),
  });

  mutationTool(ctx, {
    name: "delete_listing",
    title: "Delete listing",
    description:
      "Remove a product. Defaults to unlisting (reversible) rather than permanent deletion.",
    tier: "SENSITIVE",
    capability: "products",
    schema: {
      product_id: z.string(),
      mode: z.enum(["unlist", "delete"]).default("unlist"),
    },
    effect: (a) =>
      `${a.mode === "delete" ? "Permanently delete" : "Unlist"} product ${a.product_id}.`,
    handler: (a, platform) => platform.deleteListing({ productId: a.product_id, mode: a.mode }),
  });
}
