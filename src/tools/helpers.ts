/**
 * Shared tool-registration helpers.
 *
 * Two front doors:
 *   - readTool:     READ-tier, no consent, just resolve platform + return data.
 *   - mutationTool: SENSITIVE/CRITICAL/ROUTINE, routed through the ConsentGate
 *                   (preview -> confirm -> execute). Skipped entirely in
 *                   --read-only mode.
 *
 * Both centralize: platform resolution, capability checks, error -> MCP content
 * mapping, and clarification (NeedsInputError) surfacing.
 */
import { z, type ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import type { ConsentGate, Elicitor, RiskTier } from "../core/consent.js";
import { NeedsInputError, UnsupportedOperationError, isSellabotError } from "../core/errors.js";
import { logger } from "../core/logger.js";
import type { Capability, Platform } from "../core/platform.js";
import type { PlatformRegistry } from "../core/registry.js";
import type { PlatformName } from "../core/models.js";

export interface ToolContext {
  server: McpServer;
  registry: PlatformRegistry;
  gate: ConsentGate;
  elicitor: Elicitor;
  config: Config;
}

const platformShape = {
  platform: z
    .enum(["shopee", "lazada", "tiktok"])
    .optional()
    .describe("Marketplace to target. Defaults to shopee."),
};

const confirmationShape = {
  confirmation_token: z
    .string()
    .optional()
    .describe(
      "Echo back the token from a prior 'confirmation required' response to approve and execute this action. Only needed when the client cannot prompt directly.",
    ),
};

function jsonContent(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function textContent(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

function errorToContent(err: unknown): CallToolResult {
  if (err instanceof NeedsInputError) {
    return jsonContent({
      status: "needs_input",
      message: err.message,
      questions: err.questions,
    });
  }
  if (isSellabotError(err)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: "error",
              kind: err.kind,
              message: err.message,
              code: err.code,
              details: err.details,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  logger.error("unexpected tool error", { error: (err as Error).message });
  return textContent(
    `Unexpected error: ${(err as Error).message ?? String(err)}`,
    true,
  );
}

function resolvePlatform(ctx: ToolContext, args: { platform?: PlatformName }): Platform {
  return ctx.registry.resolve(args.platform);
}

function assertCapability(platform: Platform, capability: Capability | undefined, tool: string) {
  if (capability && !platform.capabilities.has(capability)) {
    throw new UnsupportedOperationError(
      `${platform.name} does not support "${capability}" (tool ${tool}).`,
    );
  }
}

export function readTool<S extends ZodRawShape>(
  ctx: ToolContext,
  def: {
    name: string;
    title: string;
    description: string;
    schema?: S;
    capability?: Capability;
    handler: (args: z.objectOutputType<S, z.ZodTypeAny>, platform: Platform) => Promise<unknown>;
  },
) {
  const inputSchema = { ...platformShape, ...(def.schema ?? {}) } as ZodRawShape;
  ctx.server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args: Record<string, unknown>) => {
      try {
        const platform = resolvePlatform(ctx, args);
        assertCapability(platform, def.capability, def.name);
        const value = await def.handler(args as z.objectOutputType<S, z.ZodTypeAny>, platform);
        return jsonContent(value);
      } catch (err) {
        return errorToContent(err);
      }
    },
  );
}

export function mutationTool<S extends ZodRawShape>(
  ctx: ToolContext,
  def: {
    name: string;
    title: string;
    description: string;
    tier: Exclude<RiskTier, "READ">;
    schema: S;
    capability?: Capability;
    /** Concrete, human-readable description of the effect, for the consent prompt. */
    effect: (args: z.objectOutputType<S, z.ZodTypeAny>) => string;
    handler: (args: z.objectOutputType<S, z.ZodTypeAny>, platform: Platform) => Promise<unknown>;
  },
) {
  // In read-only mode, mutating tools are simply not registered.
  if (ctx.config.server.readOnly) {
    logger.debug("skipping mutation tool (read-only mode)", { tool: def.name });
    return;
  }

  const inputSchema = {
    ...platformShape,
    ...confirmationShape,
    ...def.schema,
  } as ZodRawShape;

  ctx.server.registerTool(
    def.name,
    {
      title: def.title,
      description: `${def.description}\n\n[${def.tier}] This action changes live shop data and requires the seller's explicit confirmation before it executes.`,
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: def.tier === "CRITICAL" },
    },
    async (args: Record<string, unknown>) => {
      try {
        const platform = resolvePlatform(ctx, args);
        assertCapability(platform, def.capability, def.name);
        const typed = args as z.objectOutputType<S, z.ZodTypeAny> & {
          confirmation_token?: string;
        };
        const effect = def.effect(typed);

        const result = await ctx.gate.run(
          { tool: def.name, tier: def.tier, effect },
          () => def.handler(typed, platform),
          typed.confirmation_token,
        );

        switch (result.status) {
          case "executed":
            return jsonContent({ status: "done", effect, result: result.value });
          case "declined":
            return textContent(`Cancelled — no change was made. (${effect})`);
          case "needs_confirmation":
            return jsonContent({
              status: "confirmation_required",
              effect: result.effect,
              instructions:
                "Confirm this exact action with the seller. To proceed, call this tool again with the same arguments plus `confirmation_token`.",
              confirmation_token: result.token,
            });
        }
      } catch (err) {
        return errorToContent(err);
      }
    },
  );
}

/** Common pagination params reused across list tools. */
export const pageSchema = {
  limit: z.number().int().min(1).max(100).optional().describe("Max items (default 50, max 100)."),
  cursor: z.string().optional().describe("Opaque pagination cursor from a previous response."),
};
