#!/usr/bin/env node
/**
 * sellabot-mcp entry point. Boots the MCP server over stdio.
 *
 * stdout is reserved for the MCP transport — all logging goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { logger } from "./core/logger.js";
import { buildServer } from "./server.js";

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    logger.error("configuration error", { error: (err as Error).message });
    process.stderr.write(`\n${(err as Error).message}\n`);
    process.exit(1);
  }

  const server = buildServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("sellabot-mcp ready", {
    env: config.shopee.env,
    readOnly: config.server.readOnly,
  });
}

main().catch((err) => {
  logger.error("fatal startup error", { error: (err as Error).message });
  process.exit(1);
});
