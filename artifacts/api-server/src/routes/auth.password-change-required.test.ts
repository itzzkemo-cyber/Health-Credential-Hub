import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  actor: {
    id: 7,
    email: "worker@example.sa",
    passwordHash: "old-hash",
    sessionVersion: 0,
    mustChangePassword: true,
    isActive: true,
    totpEnabled: false,
    totpSecret: null,
    role: "employee",
    facilityId: 10,
    name: "Worker",
    nameAr: "موظف",
  },
  updateCalls: [] as Array<{
    table: "users" | "resetTokens";
    values: Record<string, unknown>;
  }>,
  logAudit: vi.fn(async () => undefined),
  setSessionCookie: vi.fn(),
  reuseNewPassword: false,
  actorAvailable: true,
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  gt: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  isNull: vi.fn((column: unknown) => ({ column })),
  sql: vi.fn(() => "session-version-plus-one"),
}));

vi.mock("@workspace/db", () => {
  const usersTable = {
    id: "users.id",
    email: "users.email",
    sessionVersion: "users.sessionVersion",
  };
  const passwordResetTokensTable = {
    id: "passwordResetTokens.id",
    userId: "passwordResetTokens.userId",
    tokenHash: "passwordResetTokens.tokenHash",
    usedAt: "passwordResetTokens.usedAt",
    expiresAt: "passwordResetTokens.expiresAt",
  };
  const auditLogsTable = { id: "auditLogs.id" };
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => {
      const rows =
        table === passwordResetTokensTable
          ? [{ id: 1, userId: testState.actor.id }]
          : testState.actorAvailable
            ? [testState.actor]
            : [];
      const terminal = Promise.resolve(rows);
      return {
        where: vi.fn(() => ({
          for: vi.fn(async () => rows),
          then: terminal.then.bind(terminal),
        })),
      };
    }),
  }));
  const insert = vi.fn(() => ({ values: vi.fn(async () => undefined) }));
  const update = vi.fn((table: unknown) => ({
    set: vi.fn((values: Record<string, unknown>) => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => {
          const tableName =
            table === passwordResetTokensTable ? "resetTokens" : "users";
          testState.updateCalls.push({ table: tableName, values });
          if (tableName === "resetTokens") {
            return [{ id: 1, userId: testState.actor.id }];
          }
          return [
            {
              ...testState.actor,
              ...values,
              sessionVersion: testState.actor.sessionVersion + 1,
              mustChangePassword: false,
            },
          ];
        }),
      })),
    })),
  }));
  const tx = { select, insert, update };
  return {
    usersTable,
    passwordResetTokensTable,
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
  signToken: vi.fn(() => "fresh-session"),
  signPurposeToken: vi.fn(),
  createTwoFactorChallengeToken: vi.fn(),
  verifyPurposeToken: vi.fn(),
  comparePassword: vi.fn(
    async (password: string) =>
      password === "temporary-pass-123" || testState.reuseNewPassword,
  ),
  hashPassword: vi.fn(async () => "new-hash"),
  setSessionCookie: testState.setSessionCookie,
  clearSessionCookie: vi.fn(),
  getUser: vi.fn(() => testState.actor),
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = testState.actor;
    next();
  },
  requireRole:
    () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("../lib/helpers", () => ({
  serializeUser: vi.fn((user: Record<string, unknown>) => ({ id: user.id })),
  logAudit: testState.logAudit,
  syncExpiryNotifications: vi.fn(async () => undefined),
}));

vi.mock("../lib/rateLimit", () => ({
  rateLimit:
    () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("../lib/csrf", () => ({
  sessionIssuanceCsrfGuard: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import router from "./auth";
import { comparePassword } from "../lib/auth";

describe("clearing the temporary-password requirement", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  beforeEach(() => {
    testState.updateCalls = [];
    testState.logAudit.mockClear();
    testState.setSessionCookie.mockClear();
    testState.reuseNewPassword = false;
    testState.actorAvailable = true;
    vi.mocked(comparePassword).mockClear();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
  });

  async function post(
    path: string,
    body: Record<string, unknown>,
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
    return fetch(`http://127.0.0.1:${address.port}/api${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function expectPasswordRequirementCleared(): void {
    expect(testState.updateCalls).toContainEqual({
      table: "users",
      values: expect.objectContaining({
        passwordHash: "new-hash",
        mustChangePassword: false,
        sessionVersion: "session-version-plus-one",
      }),
    });
  }

  it("clears the flag and rotates the session version after an authenticated change", async () => {
    const response = await post("/auth/change-password", {
      currentPassword: "temporary-pass-123",
      newPassword: "replacement-pass-456",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expectPasswordRequirementCleared();
    expect(testState.setSessionCookie).toHaveBeenCalledWith(
      expect.anything(),
      "fresh-session",
    );
  });

  it("keeps the reusable session token out of a successful login response", async () => {
    const response = await post("/auth/login", {
      email: testState.actor.email,
      password: "temporary-pass-123",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ user: { id: testState.actor.id } });
    expect(body).not.toHaveProperty("token");
    expect(testState.setSessionCookie).toHaveBeenCalledWith(
      expect.anything(),
      "fresh-session",
    );
  });

  it("runs bcrypt verification against a fixed hash for an unknown account", async () => {
    testState.actorAvailable = false;

    const response = await post("/auth/login", {
      email: "missing@example.sa",
      password: "incorrect-password",
    });

    expect(response.status).toBe(401);
    expect(comparePassword).toHaveBeenCalledWith(
      "incorrect-password",
      expect.stringMatching(/^\$2b\$10\$/),
    );
  });

  it("does not clear the flag or rotate sessions when the new password is reused", async () => {
    testState.reuseNewPassword = true;

    const response = await post("/auth/change-password", {
      currentPassword: "temporary-pass-123",
      newPassword: "temporary-pass-123",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "PASSWORD_REUSE_NOT_ALLOWED" }),
    );
    expect(testState.updateCalls).toEqual([]);
    expect(testState.actor.mustChangePassword).toBe(true);
    expect(testState.actor.sessionVersion).toBe(0);
    expect(testState.setSessionCookie).not.toHaveBeenCalled();
  });

  it("clears the flag and rotates the session version after password recovery", async () => {
    const response = await post("/auth/reset-password", {
      token: "single-use-reset-token",
      newPassword: "replacement-pass-456",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ user: { id: testState.actor.id } });
    expect(body).not.toHaveProperty("token");
    expect(testState.updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "resetTokens" }),
      ]),
    );
    expectPasswordRequirementCleared();
  });
});
