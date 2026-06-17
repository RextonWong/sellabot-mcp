/**
 * Builds the MCP server: wires config -> token store -> http -> platform
 * adapters -> registry -> consent gate -> tools.
 *
 * Also implements the `Elicitor` bridge: the consent gate and clarification
 * flow ask the seller through MCP elicitation when the client supports it,
 * and fall back to the token pattern (or structured needs_input) when it
 * doesn't.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { AuditLog } from "./core/audit.js";
import {
  ConsentGate,
  type ConfirmRequest,
  type ConfirmResult,
  type Elicitor,
  type Question,
} from "./core/consent.js";
import { HttpClient } from "./core/http.js";
import { logger } from "./core/logger.js";
import { PlatformRegistry } from "./core/registry.js";
import { SqliteTokenStore } from "./core/token-store.js";
import { createShopeeAdapter } from "./platforms/shopee/index.js";
import { registerAllTools } from "./tools/index.js";
import type { ToolContext } from "./tools/helpers.js";

class McpElicitor implements Elicitor {
  constructor(private server: McpServer) {}

  private supported(): boolean {
    const caps = this.server.server.getClientCapabilities();
    return Boolean(caps?.elicitation);
  }

  async confirm(req: ConfirmRequest): Promise<ConfirmResult> {
    if (!this.supported()) return "unsupported";
    try {
      const res = await this.server.server.elicitInput({
        message: `Approve this ${req.tier} action?\n\n${req.effect}`,
        requestedSchema: {
          type: "object",
          properties: {
            confirm: {
              type: "boolean",
              description: "Set true to approve and execute, false to cancel.",
            },
          },
          required: ["confirm"],
        },
      });
      if (res.action !== "accept") return "declined";
      return res.content?.confirm === true ? "approved" : "declined";
    } catch (err) {
      logger.warn("elicitation confirm failed; treating as unsupported", {
        error: (err as Error).message,
      });
      return "unsupported";
    }
  }

  async ask(
    questions: Question[],
  ): Promise<Record<string, string> | "unsupported" | "declined"> {
    if (!this.supported()) return "unsupported";
    type StringSchema =
      | { type: "string"; description: string }
      | { type: "string"; enum: string[]; description: string };
    const properties: Record<string, StringSchema> = {};
    for (const q of questions) {
      properties[q.field] = q.options
        ? { type: "string", enum: q.options, description: q.prompt }
        : { type: "string", description: q.prompt };
    }
    try {
      const res = await this.server.server.elicitInput({
        message: "I need a bit more information to continue:",
        requestedSchema: {
          type: "object",
          properties,
          required: questions.map((q) => q.field),
        },
      });
      if (res.action !== "accept" || !res.content) return "declined";
      return res.content as Record<string, string>;
    } catch (err) {
      logger.warn("elicitation ask failed; treating as unsupported", {
        error: (err as Error).message,
      });
      return "unsupported";
    }
  }
}

export function buildServer(config: Config): McpServer {
  logger.setLevel(config.server.logLevel);

  const server = new McpServer(
    { name: "sellabot-mcp", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Marketplace seller automation. READ tools are always safe. SENSITIVE/CRITICAL tools change live shop data: state the exact effect, recommend, and wait for the seller's explicit confirmation. Never decide a refund, cancellation, or dispute on your own.",
    },
  );

  // Shared infrastructure
  const http = new HttpClient({
    timeoutMs: config.server.requestTimeoutMs,
    maxRetries: config.server.maxRetries,
  });
  const tokens = new SqliteTokenStore(
    config.tokenStore.dbPath,
    config.tokenStore.encryptionKey,
  );
  const audit = new AuditLog(config.consent.auditLogPath);
  const elicitor = new McpElicitor(server);
  const gate = new ConsentGate(
    {
      autoConfirmTier: config.consent.autoConfirmTier,
      bulkConfirmThreshold: config.consent.bulkConfirmThreshold,
    },
    elicitor,
    audit,
  );

  // Platforms
  const registry = new PlatformRegistry();
  registry.register(createShopeeAdapter(config, http, tokens));
  logger.info("platforms registered", { platforms: registry.list() });

  // Tools
  const ctx: ToolContext = { server, registry, gate, elicitor, config };
  registerAllTools(ctx);

  return server;
}
