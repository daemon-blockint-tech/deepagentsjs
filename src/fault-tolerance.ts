import { sleep } from "./utils.js";

export interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  backoffFactor: number;
  retryOn?: (error: unknown) => boolean;
}

export function withRetry<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  options: RetryOptions,
): (...args: TArgs) => Promise<TReturn> {
  return async (...args) => {
    let delay = options.initialDelayMs;
    for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
      try {
        return await fn(...args);
      } catch (error) {
        if (attempt === options.maxRetries) throw error;
        if (options.retryOn && !options.retryOn(error)) throw error;
        await sleep(delay);
        delay *= options.backoffFactor;
      }
    }
    throw new Error("unreachable");
  };
}

export interface CallLimitOptions {
  maxCalls: number;
}

export class CallLimiter {
  private count = 0;
  constructor(private max: number) {}

  reset() {
    this.count = 0;
  }

  check() {
    if (this.count >= this.max) {
      throw new Error(`Call limit of ${this.max} exceeded`);
    }
    this.count++;
  }
}

export function withCallLimit<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  limiter: CallLimiter,
): (...args: TArgs) => Promise<TReturn> {
  return async (...args) => {
    limiter.check();
    return fn(...args);
  };
}

export interface FallbackOptions<TArgs extends unknown[], TReturn> {
  primary: (...args: TArgs) => Promise<TReturn>;
  fallback: (...args: TArgs) => Promise<TReturn>;
  shouldFallback?: (error: unknown) => boolean;
}

export function withFallback<TArgs extends unknown[], TReturn>(
  options: FallbackOptions<TArgs, TReturn>,
): (...args: TArgs) => Promise<TReturn> {
  return async (...args) => {
    try {
      return await options.primary(...args);
    } catch (error) {
      if (options.shouldFallback && !options.shouldFallback(error)) throw error;
      return options.fallback(...args);
    }
  };
}

export function isTransientError(error: unknown): boolean {
  const message = (error as { message?: unknown } | undefined)?.message;
  if (typeof message === "string") {
    const transient = [
      "timeout",
      "rate limit",
      "too many requests",
      "429",
      "503",
      "502",
      "500",
      // Node's fetch surfaces network blips as a bare "fetch failed" with
      // the real cause nested. Without these, a momentary hiccup during
      // ingest permanently leaves the object unembedded.
      "fetch failed",
      "econnreset",
      "socket hang up",
      "etimedout",
      "eai_again",
    ];
    const msg = message.toLowerCase();
    return transient.some((t) => msg.includes(t));
  }
  return false;
}
