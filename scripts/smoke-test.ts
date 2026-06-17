/**
 * Smoke test: launches the built MCP server over stdio and calls a few
 * READ-tier tools against the configured sandbox shop.
 *
 *   npx tsx scripts/smoke-test.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: process.env as Record<string, string>,
});

const client = new Client({ name: "smoke-test", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`\nServer exposes ${tools.length} tools.`);

async function call(name: string, args: Record<string, unknown>) {
  console.log(`\n── ${name}(${JSON.stringify(args)}) ──`);
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    console.log(`isError=${res.isError ?? false}`);
    console.log(text.slice(0, 700));
  } catch (err) {
    console.log("THREW:", (err as Error).message);
  }
}

await call("get_shop_info", {});
await call("get_products", { limit: 5 });
await call("get_orders", { status: "to_ship", limit: 5 });
await call("get_shop_performance", { period: "7d" });

await client.close();
console.log("\n✅ smoke test finished.");
process.exit(0);
