# sellabot-mcp

An [MCP](https://modelcontextprotocol.io) server that exposes **marketplace seller operations** as tools Claude can call. Shopee first, designed to expand to Lazada and TikTok Shop via the same adapter contract.

> Claude is the interface; sellabot-mcp is the automation layer. See [CLAUDE.md](CLAUDE.md) for the full design.

## What it can do

32 tools across products, pricing, inventory, customer service, orders & fulfillment, returns/cancellations/disputes, promotions, and shop info. The scope rule: **anything a seller can do through the marketplace API that doesn't require physically moving goods.**

Crucial actions (refunds, cancellations, disputes, booking shipments) are **human-gated** — the server previews the exact effect and waits for the seller's explicit approval before executing (see [CLAUDE.md §3](CLAUDE.md)).

## Setup

```bash
npm install
cp .env.example .env      # fill in SHOPEE_PARTNER_ID/KEY and a TOKEN_ENCRYPTION_KEY
npm run authorize         # one-time: opens the Shopee OAuth flow, stores tokens
npm run build
```

`npm run authorize` prints an authorization URL; approve it in the browser, and the local callback captures the code, exchanges it for tokens (stored encrypted), and prints the `SHOPEE_SHOP_ID` to add to `.env`.

## Run

```bash
npm start                 # serves over stdio
npm run dev               # watch mode (tsx)
```

Set `READ_ONLY=true` to expose only the `get_*` tools — safe for testing against a live shop.

## Connect to Claude

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "sellabot": {
      "command": "node",
      "args": ["C:\\Users\\Rexton\\sellabot_mcp\\dist\\index.js"],
      "env": { "SHOPEE_PARTNER_ID": "…", "SHOPEE_PARTNER_KEY": "…", "SHOPEE_REGION": "MY", "SHOPEE_ENV": "production", "SHOPEE_SHOP_ID": "…", "TOKEN_ENCRYPTION_KEY": "…" }
    }
  }
}
```

**Claude Code:**
```bash
claude mcp add sellabot -- node C:\Users\Rexton\sellabot_mcp\dist\index.js
```

## Develop

```bash
npm run typecheck    # type-check src + scripts
npm test             # signing golden-vector tests
```

## Project layout

```
src/
  index.ts           entry (stdio)
  server.ts          wiring + MCP elicitation bridge
  config.ts          env validation (Zod)
  core/              models, errors, http, token-store, consent, audit, platform, registry
  platforms/shopee/  sign, auth, client, mappers, adapter (the only Shopee-aware code)
  tools/             platform-agnostic tool definitions
scripts/authorize.ts one-time OAuth flow
```

Adding a platform = implement `Platform` in `src/platforms/<name>/` and register it. No tool changes.
