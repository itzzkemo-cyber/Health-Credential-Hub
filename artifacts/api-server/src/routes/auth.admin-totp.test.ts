import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  admin: null as Record<string, unknown> | null,
  target: null as Record<string, unknown> | null,
  set: vi.fn(),
  insertValues: vi.fn(async () => undefined),
  logAudit: vi.fn(async () => undefined),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  gt: vi.fn(),
  inArray: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  isNull: vi.fn(),
  sql: vi.fn(() => "sql-expression"),
}));

vi.mock("@workspace/db", () => {
  const usersTable = {
    id: "users.id",
    email: "users.email",
    backupCodes: "users.backupCodes",
    totpLastUsedStep: "users.totpLastUsedStep",
    sessionVersion: "users.sessionVersion",
  };
  const auditLogsTable = { id: "auditLogs.id" };
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => {
        const rows = [testState.admin, testState.target].filter(Boolean);
        return {
          for: vi.fn(async () => rows),
          orderBy: vi.fn(() => ({
            for: vi.fn(async () => rows),
          })),
        };
      }),
    })),
  }));
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      testState.set(values);
      return {
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            const base = values.totpEnabled === false
              ? testState.target
              : testState.admin;
            return base ? [{ ...base, ...values }] : [];
          }),
        })),
      };
    }),
  }));
  const insert = vi.fn(() => ({ values: testState.insertValues }));
  const tx = { select, update, insert };
  return {
    usersTable,
    passwordResetTokensTable: {},
    auditLogsTable,
    db: {
      ...tx,
      transaction: vi.fn(async (callback: (executor: typeof tx) => unknown) =>
        callback(tx),
      ),
    },
  };
});

vi.mock("../lib/auth", () => ({
  ADMIN_ROLES: ["hospital_admin", "system_admin"],
  signToken: vi.fn(),
  signPurposeToken: vi.fn(),
  createTwoFactorChallengeToken: vi.fn(),
  verifyPurposeToken: vi.fn(),
  comparePassword: vi.fn(async (password: string) => password === "admin-password"),
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

vi.mock("../lib/totp", () => ({
  generateTotpSecret: vi.fn(),
  buildOtpauthUrl: vi.fn(),
  verifyOtp: vi.fn(),
  generateBackupCodes: vi.fn(),
  hashBackupCode: vi.fn(() => "hashed-backup-code"),
  looksLikeBackupCode: vi.fn(() => true),
}));

vi.mock("../lib/totpSecret", () => ({
  decryptTotpSecret: vi.fn(),
  encryptTotpSecret: vi.fn(),
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
    totpSecret: "encrypted-secret",
    passwordHash: "admin-password-hash",
    backupCodes: ["hashed-backup-code"],
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
    testState.insertValues.mockClear();
    testState.logAudit.mockClear();
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
    return post("/auth/totp/admin-disable", {
      userId,
      currentPassword: "admin-password",
      code: "ABCD-EFGH-IJKL-MNOP",
    });
  }

  async function post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<globalThis.Response> {
    return request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "HealthCredentialHub",
      },
      body: JSON.stringify(body),
    });
  }

  async function request(
    path: string,
    init?: RequestInit,
  ): Promise<globalThis.Response> {
    const app = express();
    app.use(express.json());
    app.use("/api", router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a disposable TCP listener");
    }
    return fetch(`http://127.0.0.1:${address.port}/api${path}`, init);
  }

  it.each([
    ["demo login", "/auth/demo-login", { role: "employee" }],
    [
      "self-registration",
      "/auth/register",
      {
        name: "Worker",
        nameAr: "موظف",
        email: "worker@example.sa",
        password: "safe-password",
        facilityId: 10,
      },
    ],
  ])("does not expose the removed %s endpoint", async (_label, path, body) => {
    const response = await post(path, body);

    expect(response.status).toBe(404);
  });

  it.each(["/auth/google", "/auth/google/callback?code=test&state=test"])(
    "does not expose the removed Google OAuth endpoint %s",
    async (path) => {
      const response = await request(path);

      expect(response.status).toBe(404);
    },
  );

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
    expect(testState.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 1,
        facilityId: 10,
        target: "Account",
      }),
    );
  });

  it("requires the administrator account to have MFA before recovery", async () => {
    testState.admin = { ...testState.admin, totpEnabled: false, totpSecret: null };

    const response = await disable(2);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "admin_mfa_required" }),
    );
    expect(testState.set).not.toHaveBeenCalled();
  });

  it("rechecks the actor role from the locked database row", async () => {
    testState.admin = { ...testState.admin, role: "employee" };

    const response = await disable(2);

    expect(response.status).toBe(404);
    expect(testState.set).not.toHaveBeenCalled();
  });

  it("rejects recovery without administrator step-up credentials", async () => {
    const response = await post("/auth/totp/admin-disable", { userId: 2 });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "step_up_failed" }),
    );
    expect(testState.set).not.toHaveBeenCalled();
  });

  it("requires the current password before issuing a TOTP enrollment secret", async () => {
    testState.admin = {
      ...testState.admin,
      totpEnabled: false,
      totpSecret: null,
    };

    const response = await post("/auth/totp/setup", {
      currentPassword: "wrong-password",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "step_up_failed" }),
    );
  });
});
