import type { NextFunction, Request, RequestHandler, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rateLimit } from "./rateLimit";

interface CapturedResponse {
  headers: Record<string, string>;
  statusCode?: number;
  body?: unknown;
}

function invoke(
  handler: RequestHandler,
  input: { ip: string; actor?: string },
): CapturedResponse & { nextCalls: number } {
  const captured: CapturedResponse = { headers: {} };
  const request = {
    ip: input.ip,
    socket: { remoteAddress: input.ip },
    headers: input.actor ? { "x-test-actor": input.actor } : {},
  } as unknown as Request;
  const response = {
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
      return this;
    },
    status(statusCode: number) {
      captured.statusCode = statusCode;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;
  let nextCalls = 0;
  const next = (() => {
    nextCalls += 1;
  }) as NextFunction;

  handler(request, response, next);
  return { ...captured, nextCalls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("rateLimit", () => {
  it("preserves 429 and retry headers for a repeated identity", () => {
    const handler = rateLimit({ name: "headers", max: 1, windowMs: 60_000 });

    expect(invoke(handler, { ip: "192.0.2.1" }).nextCalls).toBe(1);
    const blocked = invoke(handler, { ip: "192.0.2.1" });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["RateLimit-Limit"]).toBe("1");
    expect(blocked.headers["RateLimit-Reset"]).toBe("60");
    expect(blocked.headers["Retry-After"]).toBe("60");
    expect(blocked.body).toEqual(
      expect.objectContaining({ code: "rate_limited" }),
    );
  });

  it("uses a custom identity across changing source IPs", () => {
    const handler = rateLimit({
      name: "actor",
      max: 1,
      windowMs: 60_000,
      keyGenerator: (req) => String(req.headers["x-test-actor"] ?? ""),
    });

    expect(
      invoke(handler, { ip: "192.0.2.1", actor: "facility:7:actor:9" })
        .nextCalls,
    ).toBe(1);
    expect(
      invoke(handler, { ip: "198.51.100.2", actor: "facility:7:actor:9" })
        .statusCode,
    ).toBe(429);
    expect(
      invoke(handler, { ip: "198.51.100.2", actor: "facility:7:actor:10" })
        .nextCalls,
    ).toBe(1);
  });

  it("falls back to the source IP when a custom key is unavailable", () => {
    const handler = rateLimit({
      name: "fallback",
      max: 1,
      windowMs: 60_000,
      keyGenerator: () => undefined,
    });

    expect(invoke(handler, { ip: "192.0.2.4" }).nextCalls).toBe(1);
    expect(invoke(handler, { ip: "192.0.2.4" }).statusCode).toBe(429);
    expect(invoke(handler, { ip: "192.0.2.5" }).nextCalls).toBe(1);
  });

  it("evicts the oldest identity instead of growing beyond its key bound", () => {
    const handler = rateLimit({
      name: "bounded",
      max: 1,
      windowMs: 60_000,
      maxKeys: 2,
      keyGenerator: (req) => String(req.headers["x-test-actor"] ?? ""),
    });

    expect(invoke(handler, { ip: "192.0.2.1", actor: "a" }).nextCalls).toBe(1);
    expect(invoke(handler, { ip: "192.0.2.1", actor: "b" }).nextCalls).toBe(1);
    expect(invoke(handler, { ip: "192.0.2.1", actor: "c" }).nextCalls).toBe(1);
    expect(invoke(handler, { ip: "192.0.2.1", actor: "a" }).nextCalls).toBe(1);
  });

  it("starts a fresh window after an expired counter is pruned", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00.000Z"));
    const handler = rateLimit({ name: "expiry", max: 1, windowMs: 1_000 });

    expect(invoke(handler, { ip: "192.0.2.8" }).nextCalls).toBe(1);
    expect(invoke(handler, { ip: "192.0.2.8" }).statusCode).toBe(429);
    vi.advanceTimersByTime(1_000);
    expect(invoke(handler, { ip: "192.0.2.8" }).nextCalls).toBe(1);
  });

  it("rejects invalid memory-bound configurations", () => {
    expect(() =>
      rateLimit({ name: "invalid", max: 1, windowMs: 1_000, maxKeys: 0 }),
    ).toThrow("Invalid rate-limit key capacity");
  });
});
