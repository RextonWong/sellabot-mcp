/**
 * Shared HTTP client: timeouts, retries with exponential backoff + jitter,
 * and mapping of transport-level failures to the SellabotError hierarchy.
 *
 * Platform adapters layer signing/auth on top of this; the retry policy lives
 * here so every platform behaves politely toward rate limits.
 */
import { RateLimitError, TransientError } from "./errors.js";
import { logger } from "./logger.js";

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  /** Parsed JSON body; will be serialized. */
  body?: unknown;
  timeoutMs?: number;
  /** Retries are only safe for idempotent calls; default true for GET. */
  idempotent?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  json: unknown;
  rawText: string;
}

export interface HttpClientOptions {
  timeoutMs: number;
  maxRetries: number;
}

const RETRIABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 8000);
  return base + Math.floor(Math.random() * 250); // jitter
}

export class HttpClient {
  constructor(private opts: HttpClientOptions) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    const idempotent = req.idempotent ?? req.method === "GET";
    const maxAttempts = idempotent ? this.opts.maxRetries + 1 : 1;
    let lastErr: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.attempt(req);
      } catch (err) {
        lastErr = err;
        const retriable =
          err instanceof RateLimitError || err instanceof TransientError;
        if (!retriable || attempt === maxAttempts - 1) throw err;

        const waitMs =
          err instanceof RateLimitError && err.retryAfterSec
            ? err.retryAfterSec * 1000
            : backoffMs(attempt);
        logger.warn("http retry", {
          url: req.url,
          attempt: attempt + 1,
          waitMs,
          reason: (err as Error).message,
        });
        await sleep(waitMs);
      }
    }
    throw lastErr;
  }

  private async attempt(req: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      req.timeoutMs ?? this.opts.timeoutMs,
    );

    let res: Response;
    try {
      res = await fetch(req.url, {
        method: req.method,
        headers: {
          "content-type": "application/json",
          ...req.headers,
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new TransientError(`Network error calling ${req.url}`, { cause: err });
    } finally {
      clearTimeout(timeout);
    }

    const rawText = await res.text();
    let json: unknown = undefined;
    if (rawText) {
      try {
        json = JSON.parse(rawText);
      } catch {
        json = undefined; // non-JSON body; leave rawText for the caller
      }
    }

    if (res.status === 429) {
      const ra = res.headers.get("retry-after");
      throw new RateLimitError("Rate limited", ra ? Number(ra) : undefined);
    }
    if (RETRIABLE_STATUS.has(res.status)) {
      throw new TransientError(`Upstream ${res.status} from ${req.url}`, {
        details: { status: res.status },
      });
    }

    return { status: res.status, headers: res.headers, json, rawText };
  }
}
