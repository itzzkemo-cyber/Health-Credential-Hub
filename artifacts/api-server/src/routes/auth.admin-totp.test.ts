import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  admin: null as Record<string, unknown> | null,
  target: null as Record<string, unknown> | null,
  set: vi.fn(),
  updateWhere: vi.fn(async () => undefined),
  logAudit: vi.fn(async () => undefined),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  gt: vi.fn(),
  isNull: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("@workspace/db", () => {
  const usersTable = {
    id: "users.id",
    email: "users.email",
    sessionVersion: "users.sessionVersion",
  };
  return {
    usersTable,
    facilitiesTable: {},
    passwordResetTokensTable: {},
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => (testState.target ? [testState.target] : [])),
        })),
      })),
      update: vi.fn(() => ({ set: testState.set })),
    },
  };
});

vi.mock("../lib/auth", () => ({
  ADMIN_ROLES: ["hospital_admin", "system_admin"],
  signToken: vi.fn(),
  signPurposeToken: vi.fn(),
  createTwoFactorChallengeToken: vi.fn(),
  verifyPurposeToken: vi.fn(),
  comparePassword: vi.fn(),
  hashPassword: vi.fn(),
  setSessionCookie: vi.fn(),
  clearSessionCookie: vi.fn(),
  getUser: vi.fn(() => testState.admin),
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = testState.admin;
    next();
  },
  requireRole:
    () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("../lib/helpers", () => ({
  serializeUser: vi.fn(),
  logAudit: testState.logAudit,
  syncExpiryNotifications: vi.fn(),
}));

vi.mock("../lib/rateLimit", () => ({
  rateLimit:
    () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import router from "./auth";

function account(
  id: number,
  role: string,
  facilityId = 10,
): Record<string, unknown> {
  return {
    id,
    role,
    facilityId,
    isActive: true,
    totpEnabled: true,
    name: `User ${id}`,
    nameAr: `مستخدم ${id}`,
  };
}

describe("administrative TOTP recovery hierarchy", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  beforeEach(() => {
    testState.admin = account(1, "hospital_admin");
    testState.target = account(2, "employee");
    testState.set.mockReset();
    testState.updateWhere.mockClear();
    testState.logAudit.mockClear();
    testState.set.mockReturnValue({ where: testState.updateWhere });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
  });

  async function disable(userId: number): Promise<globalThis.Response> {
    const app = express();
    app.use(express.json());
    app.use("/api", router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a disposable TCP listener");
    }
    return fetch(
      `http://127.0.0.1:${address.port}/api/auth/totp/admin-disable`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      },
    );
  }

  it.each([
    ["peer", account(2, "hospital_admin", 10)],
    ["higher role", account(2, "system_admin", 10)],
    ["cross-facility target", account(2, "employee", 20)],
  ])("hides an unauthorized %s", async (_label, target) => {
    testState.target = target;

    const response = await disable(2);

    expect(response.status).toBe(404);
    expect(testState.set).not.toHaveBeenCalled();
  });

  it("keeps the self-disable bypass blocked", async () => {
    testState.target = testState.admin;

    const response = await disable(1);

    expect(response.status).toBe(403);
    expect(testState.set).not.toHaveBeenCalled();
  });

  it("allows same-facility recovery for a lower-ranked account", async () => {
    const response = await disable(2);

    expect(response.status).toBe(200);
    expect(testState.set).toHaveBeenCalledWith(
      expect.objectContaining({ totpEnabled: false, totpSecret: null }),
    );
    expect(testState.logAudit).toHaveBeenCalledWith(
      testState.admin,
      expect.any(String),
      expect.any(String),
      "Account",
      "الحساب",
      undefined,
      expect.any(String),
      10,
    );
  });
});
