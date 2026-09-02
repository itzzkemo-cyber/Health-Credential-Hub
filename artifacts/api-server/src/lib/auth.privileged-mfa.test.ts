import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  return {
    user: {
      id: 1,
      role: "supervisor",
      isActive: true,
      sessionVersion: 0,
      mustChangePassword: false,
      totpEnabled: false,
      totpSecret: null as string | null,
    },
  };
});

vi.mock("jsonwebtoken", () => ({
  default: {
    sign: vi.fn(),
    verify: vi.fn(() => ({ sub: String(testState.user.id), v: 0 })),
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

function requestFor(method: string, originalUrl: string): Request {
  return {
    method,
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

async function authorize(method: string, originalUrl: string) {
  const response = responseRecorder();
  const next = vi.fn() as NextFunction;
  await requireAuth(requestFor(method, originalUrl), response, next);
  return { response, next };
}

describe("protected-account TOTP enrollment gate", () => {
  beforeEach(() => {
    testState.user.id = 1;
    testState.user.role = "supervisor";
    testState.user.isActive = true;
    testState.user.sessionVersion = 0;
    testState.user.mustChangePassword = false;
    testState.user.totpEnabled = false;
    testState.user.totpSecret = null;
  });

  it.each([
    "employee",
    "supervisor",
    "department_manager",
    "hospital_admin",
    "system_admin",
  ])("blocks protected account access after a role change to %s", async (role) => {
    testState.user.role = role;

    const { response, next } = await authorize("GET", "/api/dashboard");

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "MFA_ENROLLMENT_REQUIRED" }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/api/auth/me?refresh=1"],
    ["POST", "/api/auth/change-password?source=temporary"],
    ["POST", "/api/auth/logout?all=true"],
    ["POST", "/api/auth/totp/setup"],
    ["POST", "/api/auth/totp/verify-setup"],
  ])("allows the exact enrollment request %s %s", async (method, path) => {
    const { response, next } = await authorize(method, path);

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/api/auth/totp/setup"],
    ["POST", "/api/auth/totp/setup/"],
    ["POST", "/api/auth/totp/verify-setup-extra"],
    ["GET", "/api/auth/logout"],
  ])("rejects a method or path outside the narrow exception: %s %s", async (method, path) => {
    const { response, next } = await authorize(method, path);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "MFA_ENROLLMENT_REQUIRED" }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    "employee",
    "supervisor",
    "department_manager",
    "hospital_admin",
    "system_admin",
  ])("does not impose the enrollment gate on non-protected %s accounts", async (role) => {
    testState.user.id = 2;
    testState.user.role = role;

    const { response, next } = await authorize("GET", "/api/dashboard");

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
  });

  it("allows the protected account only when enabled TOTP has a stored secret", async () => {
    testState.user.role = "hospital_admin";
    testState.user.totpEnabled = true;
    testState.user.totpSecret = "encrypted-secret";

    const { response, next } = await authorize("GET", "/api/dashboard");

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
  });

  it("fails closed when the enabled flag has no TOTP secret", async () => {
    testState.user.totpEnabled = true;

    const { response, next } = await authorize("GET", "/api/dashboard");

    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("requires a temporary password change before starting TOTP enrollment", async () => {
    testState.user.mustChangePassword = true;

    const { response, next } = await authorize(
      "POST",
      "/api/auth/totp/setup",
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PASSWORD_CHANGE_REQUIRED" }),
    );
    expect(next).not.toHaveBeenCalled();
  });
});
