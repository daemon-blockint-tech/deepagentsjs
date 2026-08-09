import process from "node:process";
import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import { type Request, type Response, type NextFunction } from "express";
import { rateLimitViolationsTotal } from "./metrics.js";

interface TokenBucket {
  tokens: number;
  lastUpdate: number;
}

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  burst: number;
}

const DEFAULT_CHAT_LIMIT: RateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 20,
  burst: 5,
};

const EXPENSIVE_MODEL_LIMIT: RateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 5,
  burst: 2,
};

const EXPENSIVE_MODELS = new Set([
  "qwen/qwen-image-3-pro",
  "openai/gpt-transcribe",
]);

function isExpensiveModel(model?: string): boolean {
  return Boolean(model && EXPENSIVE_MODELS.has(model));
}

const hasRedisEnv = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);
const redis = hasRedisEnv
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })
  : null;

const localStore = new Map<string, TokenBucket>();

async function getBucket(key: string): Promise<TokenBucket | null> {
  if (redis) {
    const raw = await redis.get<string>(key);
    return raw ? (JSON.parse(raw) as TokenBucket) : null;
  }
  const value = localStore.get(key);
  return value ?? null;
}

async function setBucket(
  key: string,
  bucket: TokenBucket,
  ttlMs: number,
): Promise<void> {
  if (redis) {
    await redis.set(key, JSON.stringify(bucket), { px: ttlMs });
  } else {
    localStore.set(key, bucket);
  }
}

export async function checkRateLimit(
  key: string,
  config: RateLimitConfig,
  cost = 1,
): Promise<{ allowed: boolean; retryAfter: number }> {
  const now = Date.now();
  const refillRate = config.maxRequests / config.windowMs; // tokens per ms
  const bucket = (await getBucket(key)) ?? {
    tokens: config.burst,
    lastUpdate: now,
  };

  const elapsed = now - bucket.lastUpdate;
  bucket.tokens = Math.min(config.burst, bucket.tokens + elapsed * refillRate);
  bucket.lastUpdate = now;

  if (bucket.tokens >= cost) {
    bucket.tokens -= cost;
    await setBucket(key, bucket, config.windowMs);
    return { allowed: true, retryAfter: 0 };
  }

  const needed = cost - bucket.tokens;
  const retryAfterMs = needed / refillRate;
  const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));

  // Do not write the bucket back when rejecting — tokens stay available for the window.
  return { allowed: false, retryAfter };
}

// Key buckets by a hash of the bearer token (one per authenticated session,
// and not spoofable via a self-chosen header) or by client IP otherwise.
// The raw token is never stored.
function getRateLimitKey(req: Request): string {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    if (token) {
      return `token:${createHash("sha256").update(token).digest("hex")}`;
    }
  }
  return `ip:${req.ip ?? "anonymous"}`;
}

export function rateLimitMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = getRateLimitKey(req);
      const model = typeof req.body === "object" ? req.body?.model : undefined;
      const baseKey = `ratelimit:chat:${key}`;
      const modelKey = `ratelimit:model:${key}:${model ?? "default"}`;

      const baseResult = await checkRateLimit(baseKey, DEFAULT_CHAT_LIMIT);
      if (!baseResult.allowed) {
        rateLimitViolationsTotal.inc({
          endpoint: req.path,
          key_type: "user",
          model: model ?? "default",
        });
        res.setHeader("Retry-After", String(baseResult.retryAfter));
        res.setHeader(
          "X-RateLimit-Limit",
          String(DEFAULT_CHAT_LIMIT.maxRequests),
        );
        res
          .status(429)
          .json({ error: "Rate limit exceeded. Try again later." });
        return;
      }

      if (isExpensiveModel(model)) {
        const modelResult = await checkRateLimit(
          modelKey,
          EXPENSIVE_MODEL_LIMIT,
        );
        if (!modelResult.allowed) {
          rateLimitViolationsTotal.inc({
            endpoint: req.path,
            key_type: "model",
            model,
          });
          res.setHeader("Retry-After", String(modelResult.retryAfter));
          res.setHeader(
            "X-RateLimit-Limit",
            String(EXPENSIVE_MODEL_LIMIT.maxRequests),
          );
          res.status(429).json({
            error: `Rate limit exceeded for model ${model}. Try again later.`,
          });
          return;
        }
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
