import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  return {
    user: {
      id: 7,
      isActive: true,
      sessionVersion: 0,
      mustChangePassword: true,
    },
  };
});

vi.mock("jsonwebtoken", () => ({
  default: {
    sign: vi.fn(),
    verify: vi.fn(() => ({ sub: "7", v: 0 })),
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
}));

vi.mock("@workspace/db", () => ({
  usersTable: { id: "users.id" },
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [testState.user]),
      })),
    })),
  },
}));

import { requireAuth } from "./auth";

function requestFor(originalUrl: string): Request {
  return {
    originalUrl,
    headers: { authorization: "Bearer test-session" },
    cookies: {},
  } as unknown as Request;
}

function responseRecorder() {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

describe("temporary-password session gate", () => {
  beforeEach(() => {
    testState.user.mustChangePassword = true;
    testState.user.sessionVersion = 0;
  });

  it("blocks ordinary API access until the temporary password is replaced", async () => {
    const response = responseRecorder();
    const next = vi.fn() as NextFunction;

    await requireAuth(
      requestFor("/api/employees?search=worker"),
      response,
      next,
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PASSWORD_CHANGE_REQUIRED" }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    "/api/auth/me?refresh=1",
    "/api/auth/change-password?source=temporary",
    "/api/auth/logout?all=true",
  ])("allows the exact recovery endpoint %s", async (originalUrl) => {
    const response = responseRecorder();
    const next = vi.fn() as NextFunction;

    await requireAuth(requestFor(originalUrl), response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
  });

  it("does not widen the recovery allowlist to similar paths", async () => {
    const response = responseRecorder();
    const next = vi.fn() as NextFunction;

    await requireAuth(requestFor("/api/auth/me/"), response, next);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("allows normal sessions through", async () => {
    testState.user.mustChangePassword = false;
    const response = responseRecorder();
    const next = vi.fn() as NextFunction;

    await requireAuth(requestFor("/api/employees"), response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
  });

  it("rejects an older token after the account session version is rotated", async () => {
    testState.user.mustChangePassword = false;
    testState.user.sessionVersion = 1;
    const response = responseRecorder();
    const next = vi.fn() as NextFunction;

    await requireAuth(requestFor("/api/employees"), response, next);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({ message: "Unauthorized" });
    expect(next).not.toHaveBeenCalled();
  });
});
