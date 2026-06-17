/**
 * Internal error hierarchy. Adapters throw these; the tool wrapper catches them
 * and maps them to structured MCP tool errors (never raw stacks / secrets).
 */

export type ErrorKind =
  | "auth"
  | "rate_limit"
  | "validation"
  | "not_found"
  | "unsupported"
  | "needs_input"
  | "platform"
  | "transient";

export interface SellabotErrorOptions {
  /** Platform-native error code, preserved for diagnostics. */
  code?: string;
  /** Structured detail surfaced to the model under `details`. */
  details?: unknown;
  /** Whether retrying the same call could succeed. */
  retriable?: boolean;
  cause?: unknown;
}

export class SellabotError extends Error {
  readonly kind: ErrorKind;
  readonly code?: string;
  readonly details?: unknown;
  readonly retriable: boolean;

  constructor(kind: ErrorKind, message: string, opts: SellabotErrorOptions = {}) {
    super(message, { cause: opts.cause });
    this.name = new.target.name;
    this.kind = kind;
    this.code = opts.code;
    this.details = opts.details;
    this.retriable = opts.retriable ?? false;
  }
}

export class AuthError extends SellabotError {
  constructor(message: string, opts: SellabotErrorOptions = {}) {
    super("auth", message, opts);
  }
}

export class RateLimitError extends SellabotError {
  /** Seconds to wait before retrying, if the platform told us. */
  readonly retryAfterSec?: number;
  constructor(message: string, retryAfterSec?: number, opts: SellabotErrorOptions = {}) {
    super("rate_limit", message, { retriable: true, ...opts });
    this.retryAfterSec = retryAfterSec;
  }
}

export class ValidationError extends SellabotError {
  constructor(message: string, opts: SellabotErrorOptions = {}) {
    super("validation", message, opts);
  }
}

export class NotFoundError extends SellabotError {
  constructor(message: string, opts: SellabotErrorOptions = {}) {
    super("not_found", message, opts);
  }
}

export class UnsupportedOperationError extends SellabotError {
  constructor(message: string, opts: SellabotErrorOptions = {}) {
    super("unsupported", message, opts);
  }
}

/** Thrown when a tool cannot proceed without more information from the seller. */
export class NeedsInputError extends SellabotError {
  /** Structured description of what is missing, so the model can ask. */
  readonly questions: Array<{ field: string; prompt: string; options?: string[] }>;
  constructor(
    message: string,
    questions: Array<{ field: string; prompt: string; options?: string[] }>,
    opts: SellabotErrorOptions = {},
  ) {
    super("needs_input", message, opts);
    this.questions = questions;
  }
}

export class PlatformError extends SellabotError {
  constructor(message: string, opts: SellabotErrorOptions = {}) {
    super("platform", message, opts);
  }
}

export class TransientError extends SellabotError {
  constructor(message: string, opts: SellabotErrorOptions = {}) {
    super("transient", message, { retriable: true, ...opts });
  }
}

export function isSellabotError(e: unknown): e is SellabotError {
  return e instanceof SellabotError;
}
