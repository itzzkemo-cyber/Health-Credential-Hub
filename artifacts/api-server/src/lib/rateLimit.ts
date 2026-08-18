import type { NextFunction, Request, RequestHandler, Response } from "express";

interface RateLimitOptions {
  name: string;
  max: number;
  windowMs: number;
}

interface Counter {
  count: number;
  resetAt: number;
}

const counters = new Map<string, Counter>();
let requestsSinceCleanup = 0;

/**
 * Small single-instance safety net for public authentication endpoints.
 * Production clusters should replace this with a shared Redis-backed limiter.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    requestsSinceCleanup += 1;
    if (requestsSinceCleanup >= 500) {
      requestsSinceCleanup = 0;
      for (const [key, counter] of counters) {
        if (counter.resetAt <= now) counters.delete(key);
      }
    }

    const key = `${options.name}:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
    const current = counters.get(key);
    const counter =
      current && current.resetAt > now
        ? current
        : { count: 0, resetAt: now + options.windowMs };
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

