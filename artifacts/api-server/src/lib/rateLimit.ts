import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createHash } from "node:crypto";

export interface RateLimitOptions {
  name: string;
  max: number;
  windowMs: number;
  /**
   * Select a stable, non-sensitive identity for this budget. Returning an
   * empty value falls back to the client IP, so malformed public requests are
   * still throttled. The selected value is hashed before it enters memory.
   */
  keyGenerator?: (req: Request) => string | null | undefined;
  /** Maximum live identities retained by this single limiter instance. */
  maxKeys?: number;
}

interface Counter {
  count: number;
  resetAt: number;
}

const DEFAULT_MAX_KEYS = 5_000;
const CLEANUP_INTERVAL_REQUESTS = 128;

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function inMemoryKey(value: string): string {
  // Besides fixing the maximum retained key length, hashing prevents a future
  // caller from accidentally leaving an email address or bearer token in the
  // process heap through a custom key generator.
  return createHash("sha256").update(value).digest("base64url");
}

/**
 * Small single-instance safety net for sensitive or resource-heavy endpoints.
 * Production clusters should replace this with a shared Redis-backed limiter.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  if (
    !options.name ||
    !Number.isSafeInteger(options.max) ||
    options.max < 1 ||
    !Number.isSafeInteger(options.windowMs) ||
    options.windowMs < 1
  ) {
    throw new Error("Invalid rate-limit configuration");
  }
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) {
    throw new Error("Invalid rate-limit key capacity");
  }

  // Keep state local to the middleware instance. Routes that intentionally
  // share a budget reuse the same returned handler.
  const counters = new Map<string, Counter>();
  let requestsSinceCleanup = 0;

  const pruneExpired = (now: number): void => {
    for (const [key, counter] of counters) {
      if (counter.resetAt <= now) counters.delete(key);
    }
  };

  const makeRoom = (): void => {
    if (counters.size < maxKeys) return;
    // Expired entries are already swept on a fixed cadence above. Avoid a
    // full-map scan for every new identity after saturation; otherwise a
    // high-cardinality attack could turn the memory defence into CPU work.
    while (counters.size >= maxKeys) {
      const oldestKey = counters.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      counters.delete(oldestKey);
    }
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    requestsSinceCleanup += 1;
    if (requestsSinceCleanup >= CLEANUP_INTERVAL_REQUESTS) {
      requestsSinceCleanup = 0;
      pruneExpired(now);
    }

    const selectedKey = options.keyGenerator?.(req);
    const identity =
      typeof selectedKey === "string" && selectedKey.length > 0
        ? selectedKey
        : `ip:${clientIp(req)}`;
    const key = `${options.name}:${inMemoryKey(identity)}`;
    const current = counters.get(key);
    if (current && current.resetAt <= now) counters.delete(key);
    const counter =
      current && current.resetAt > now
        ? current
        : { count: 0, resetAt: now + options.windowMs };
    if (!current || current.resetAt <= now) makeRoom();
    counter.count += 1;
    counters.set(key, counter);

    res.setHeader("RateLimit-Limit", String(options.max));
    res.setHeader(
      "RateLimit-Reset",
      String(Math.max(1, Math.ceil((counter.resetAt - now) / 1000))),
    );
    if (counter.count > options.max) {
      res.setHeader(
        "Retry-After",
        String(Math.max(1, Math.ceil((counter.resetAt - now) / 1000))),
      );
      res.status(429).json({
        code: "rate_limited",
        message: "Too many requests; try again later",
        messageAr: "طلبات كثيرة؛ حاول مرة أخرى لاحقًا",
      });
      return;
    }
    next();
  };
}
