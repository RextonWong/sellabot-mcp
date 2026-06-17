/**
 * Tiny local HTTP server that captures the Shopee OAuth redirect
 * (?code=...&shop_id=...) during `npm run authorize`.
 */
import { createServer } from "node:http";

export interface CallbackResult {
  code: string;
  shopId: string;
}

export function waitForCallback(port: number, path = "/callback"): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "", `http://localhost:${port}`);
      if (url.pathname !== path) {
        res.writeHead(404).end("Not found");
        return;
      }
      const code = url.searchParams.get("code");
      const shopId = url.searchParams.get("shop_id");
      if (!code || !shopId) {
        res.writeHead(400).end("Missing code or shop_id in callback.");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(
        "<h2>Shopee authorization complete.</h2><p>You can close this tab and return to the terminal.</p>",
      );
      server.close();
      resolve({ code, shopId });
    });
    server.on("error", reject);
    server.listen(port);
  });
}
