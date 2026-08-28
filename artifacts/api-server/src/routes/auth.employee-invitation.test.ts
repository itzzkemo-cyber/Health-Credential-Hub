import { createHash } from "node:crypto";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RAW_TOKEN = "a".repeat(64);
const TOKEN_HASH = createHash("sha256").update(RAW_TOKEN).digest("hex");

const state = vi.hoisted(() => ({
  invitation: null as Record<string, any> | null,
  inviter: null as Record<string, any> | null,
  supervisor: null as Record<string, any> | null,
  department: null as Record<string, any> | null,
  facilityRows: [{ id: 10 }] as Array<Record<string, unknown>>,
  existingEmailRows: [] as Array<Record<string, unknown>>,
  userInsert: null as Record<string, unknown> | null,
  invitationUpdate: null as Record<string, unknown> | null,
  auditInsert: null as Record<string, unknown> | null,
  outsideRevocation: false,
  uniqueRace: false,
  transactionCount: 0,
  hashPassword: vi.fn(async (_password: string) => "new-password-hash"),
  setSessionCookie: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  gt: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  inArray: vi.fn((column: unknown, values: unknown[]) => ({ column, values })),
  isNull: vi.fn((column: unknown) => ({ column, isNull: true })),
  sql: vi.fn(() => ({ kind: "sql" })),
}));

vi.mock("@workspace/db", () => {
  const employeeInvitationsTable = {
    kind: "employeeInvitations",
    id: "employeeInvitations.id",
    tokenHash: "employeeInvitations.tokenHash",
    email: "employeeInvitations.email",
    acceptedAt: "employeeInvitations.acceptedAt",
    revokedAt: "employeeInvitations.revokedAt",
    expiresAt: "employeeInvitations.expiresAt",
  };
  const usersTable = {
    kind: "users",
    id: "users.id",
    email: "users.email",
    sessionVersion: "users.sessionVersion",
    backupCodes: "users.backupCodes",
    totpLastUsedStep: "users.totpLastUsedStep",
  };
  const departmentsTable = {
    kind: "departments",
    id: "departments.id",
    facilityId: "departments.facilityId",
    deletedAt: "departments.deletedAt",
  };
  const facilitiesTable = { kind: "facilities", id: "facilities.id" };
  const auditLogsTable = { kind: "auditLogs" };

  const outsideUpdate = (table: unknown) => ({
    set: () => ({
      where: async () => {
        if (table === employeeInvitationsTable) state.outsideRevocation = true;
      },
    }),
  });

  return {
    employeeInvitationsTable,
    usersTable,
    departmentsTable,
    facilitiesTable,
    auditLogsTable,
    passwordResetTokensTable: {},
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(async () => []) })),
      })),
      insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
      update: vi.fn(outsideUpdate),
      transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => {
        state.transactionCount += 1;
        const tx = {
          execute: vi.fn(async () => undefined),
          select: (_selection?: unknown) => ({
            from: (table: unknown) => ({
              where: (condition: unknown) => {
                if (table === employeeInvitationsTable) {
                  const rows = state.invitation ? [state.invitation] : [];
                  const terminal = Promise.resolve(rows);
                  return {
                    then: terminal.then.bind(terminal),
                    for: async () => rows,
                  };
                }
                if (table === departmentsTable) {
                  return {
                    for: async () =>
                      state.department ? [state.department] : [],
                  };
                }
                if (table === usersTable) {
                  if (
                    typeof condition === "object" &&
                    condition !== null &&
                    "values" in condition
                  ) {
                    const ids = (condition as { values: number[] }).values;
                    const users = [state.inviter, state.supervisor]
                      .filter((value): value is Record<string, any> =>
                        Boolean(value),
                      )
                      .filter((user) => ids.includes(user.id as number))
                      .sort(
                        (left, right) =>
                          (left.id as number) - (right.id as number),
                      );
                    return { orderBy: () => ({ for: async () => users }) };
                  }
                  return Promise.resolve(state.existingEmailRows);
                }
                if (table === facilitiesTable) {
                  return Promise.resolve(state.facilityRows);
                }
                throw new Error("Unexpected select table");
              },
            }),
          }),
          insert: (table: unknown) => ({
            values: (values: Record<string, unknown>) => {
              if (table === usersTable) {
                state.userInsert = values;
                return {
                  returning: async () => {
                    if (state.uniqueRace) {
                      throw Object.assign(new Error("query failed"), {
                        cause: Object.assign(new Error("private detail"), {
                          code: "23505",
                        }),
                      });
                    }
                    return [
                      {
                        id: 22,
                        ...values,
                        createdAt: new Date("2026-08-28T00:00:00.000Z"),
                      },
                    ];
                  },
                };
              }
              if (table === auditLogsTable) {
                state.auditInsert = values;
                return Promise.resolve();
              }
              throw new Error("Unexpected insert table");
            },
          }),
          update: (table: unknown) => ({
            set: (values: Record<string, unknown>) => ({
              where: () => {
                if (table !== employeeInvitationsTable) {
                  throw new Error("Unexpected update table");
                }
                state.invitationUpdate = values;
                const terminal = Promise.resolve(undefined);
                return {
                  then: terminal.then.bind(terminal),
                  returning: async () => [{ id: state.invitation?.id ?? 81 }],
                };
              },
            }),
          }),
        };
        return callback(tx);
      }),
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
  hashPassword: state.hashPassword,
  setSessionCookie: state.setSessionCookie,
  clearSessionCookie: vi.fn(),
  getUser: vi.fn(),
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) =>
    next(),
}));

vi.mock("../lib/rateLimit", () => ({
  rateLimit: () => (_req: Request, _res: Response, next: NextFunction) =>
    next(),
}));

vi.mock("../lib/csrf", () => ({
  sessionIssuanceCsrfGuard: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));

vi.mock("../lib/helpers", () => ({
  serializeUser: vi.fn(),
  logAudit: vi.fn(async () => undefined),
  syncExpiryNotifications: vi.fn(async () => undefined),
}));

vi.mock("../lib/totp", () => ({
  generateTotpSecret: vi.fn(),
  buildOtpauthUrl: vi.fn(),
  verifyOtp: vi.fn(),
  generateBackupCodes: vi.fn(),
}));

vi.mock("../lib/totpSecret", () => ({
  encryptTotpSecret: vi.fn(),
}));

vi.mock("../lib/secondFactor", () => ({
  consumeSecondFactor: vi.fn(),
}));

vi.mock("../lib/sessionFreshness", () => ({
  isFreshActiveSessionActor: vi.fn(() => true),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../lib/email/sender", () => ({
  EmailNotConfiguredError: class extends Error {},
  createEmailIdempotencyKey: vi.fn(),
  isEmailConfigured: vi.fn(() => false),
  isFixtureRecipient: vi.fn(() => false),
  sendEmail: vi.fn(),
}));

vi.mock("../lib/email/templates", () => ({
  getPasswordResetUrl: vi.fn(),
  passwordResetEmail: vi.fn(),
}));

vi.mock("../lib/safeError", () => ({
  safeErrorLogFields: vi.fn(() => ({})),
}));

import router from "./auth";

describe("public employee invitation acceptance", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  beforeEach(() => {
    state.invitation = {
      id: 81,
      tokenHash: TOKEN_HASH,
      email: "new.worker@example.sa",
      invitedBy: 1,
      facilityId: 10,
      departmentId: 7,
      supervisorId: 3,
      name: "New Worker",
      nameAr: "موظف جديد",
      jobTitle: "Nurse",
      jobTitleAr: "ممرض",
      employeeNumber: "EMP-2",
      phone: "+966500000000",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      revokedAt: null,
      acceptedAt: null,
    };
    state.inviter = {
      id: 1,
      role: "hospital_admin",
      facilityId: 10,
      isActive: true,
    };
    state.supervisor = {
      id: 3,
      role: "supervisor",
      facilityId: 10,
      isActive: true,
    };
    state.department = { id: 7, facilityId: 10 };
    state.facilityRows = [{ id: 10 }];
    state.existingEmailRows = [];
    state.userInsert = null;
    state.invitationUpdate = null;
    state.auditInsert = null;
    state.outsideRevocation = false;
    state.uniqueRace = false;
    state.transactionCount = 0;
    state.hashPassword.mockClear();
    state.setSessionCookie.mockClear();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
  });

  async function accept(
    overrides: Record<string, unknown> = {},
  ): Promise<globalThis.Response> {
    const app = express();
    app.use(express.json());
    app.use("/api", router);
    app.use(
      (_error: unknown, _req: Request, res: Response, _next: NextFunction) =>
        res.status(500).json({ message: "Internal server error" }),
    );
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    return fetch(
      `http://127.0.0.1:${address.port}/api/auth/accept-invitation`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "HealthCredentialHub",
        },
        body: JSON.stringify({
          token: RAW_TOKEN,
          password: "  strong password  ",
          ...overrides,
        }),
      },
    );
  }

  it("creates only the authoritative employee profile atomically and issues no session", async () => {
    const response = await accept();

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(
      expect.objectContaining({ success: true }),
    );
    expect(state.hashPassword).toHaveBeenCalledWith("  strong password  ");
    expect(state.userInsert).toEqual({
      email: "new.worker@example.sa",
      passwordHash: "new-password-hash",
      name: "New Worker",
      nameAr: "موظف جديد",
      role: "employee",
      departmentId: 7,
      supervisorId: 3,
      facilityId: 10,
      jobTitle: "Nurse",
      jobTitleAr: "ممرض",
      employeeNumber: "EMP-2",
      phone: "+966500000000",
      isActive: true,
      mustChangePassword: false,
      sessionVersion: 1,
    });
    expect(state.invitationUpdate).toEqual(
      expect.objectContaining({
        acceptedAt: expect.any(Date),
        acceptedUserId: 22,
      }),
    );
    expect(state.auditInsert).toEqual(
      expect.objectContaining({
        userId: 22,
        facilityId: 10,
        action: "Accepted employee invitation",
      }),
    );
    expect(state.setSessionCookie).not.toHaveBeenCalled();
  });

  it.each([
    ["expired", { expiresAt: new Date(Date.now() - 1_000) }],
    ["replayed", { acceptedAt: new Date() }],
    ["revoked", { revokedAt: new Date() }],
  ])(
    "returns the same generic response for an %s invitation",
    async (_label, patch) => {
      Object.assign(state.invitation!, patch);

      const response = await accept();

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(
        expect.objectContaining({ code: "invalid_invitation" }),
      );
      expect(state.userInsert).toBeNull();
    },
  );

  it("rejects an overlong invitation password before hashing or database work", async () => {
    const response = await accept({ password: "x".repeat(1025) });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "weak_password" }),
    );
    expect(state.hashPassword).not.toHaveBeenCalled();
    expect(state.transactionCount).toBe(0);
    expect(state.userInsert).toBeNull();
  });

  it("rejects tenant or role injection fields with the generic response", async () => {
    const response = await accept({ facilityId: 99, role: "system_admin" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "invalid_invitation" }),
    );
    expect(state.transactionCount).toBe(0);
    expect(state.userInsert).toBeNull();
  });

  it("invalidates an invitation when the inviter no longer controls its facility", async () => {
    state.inviter!.facilityId = 99;

    const response = await accept();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "invalid_invitation" }),
    );
    expect(state.userInsert).toBeNull();
    expect(state.invitationUpdate).toEqual(
      expect.objectContaining({ revokedAt: expect.any(Date) }),
    );
  });

  it("invalidates an invitation when its supervisor is no longer higher-ranked", async () => {
    state.supervisor!.role = "employee";

    const response = await accept();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "invalid_invitation" }),
    );
    expect(state.userInsert).toBeNull();
    expect(state.invitationUpdate).toEqual(
      expect.objectContaining({ revokedAt: expect.any(Date) }),
    );
  });

  it("maps a raced email uniqueness violation to the generic response and revokes the link", async () => {
    state.uniqueRace = true;

    const response = await accept();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "invalid_invitation" }),
    );
    expect(state.outsideRevocation).toBe(true);
  });
});
