import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  actor: {
    id: 1,
    role: "hospital_admin",
    facilityId: 10,
    isActive: true,
    name: "Facility Admin",
    nameAr: "مدير المنشأة",
  },
  selectResults: [] as Array<Array<Record<string, unknown>>>,
  insertValues: null as Record<string, unknown> | null,
  auditValues: null as Record<string, unknown> | null,
  committedUser: null as Record<string, unknown> | null,
  transactionCount: 0,
  transactionRolledBack: false,
  failAudit: false,
  uniqueInsert: false,
  logAudit: vi.fn(async () => undefined),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  isNull: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("@workspace/db", () => {
  const usersTable = {
    id: "users.id",
    email: "users.email",
    facilityId: "users.facilityId",
  };
  const facilitiesTable = { id: "facilities.id" };
  const auditLogsTable = { kind: "auditLogs" };
  return {
    usersTable,
    credentialsTable: {},
    facilitiesTable,
    auditLogsTable,
    departmentsTable: { id: "departments.id", facilityId: "departments.facilityId" },
    USER_ROLES: [
      "employee",
      "supervisor",
      "department_manager",
      "hospital_admin",
      "system_admin",
    ],
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => testState.selectResults.shift() ?? []),
        })),
      })),
      transaction: vi.fn(
        async (
          callback: (transaction: {
            insert: (table: unknown) => {
              values: (values: Record<string, unknown>) => unknown;
            };
          }) => Promise<Record<string, unknown>>,
        ) => {
          testState.transactionCount += 1;
          const transaction = {
            insert: (table: unknown) => ({
              values: (values: Record<string, unknown>) => {
                if (table === usersTable) {
                  testState.insertValues = values;
                  return {
                    returning: async () => {
                      if (testState.uniqueInsert) {
                        const databaseError = Object.assign(
                          new Error("duplicate key detail must stay private"),
                          { code: "23505" },
                        );
                        throw Object.assign(new Error("query failed"), {
                          cause: databaseError,
                        });
                      }
                      return [
                        {
                          id: 2,
                          ...values,
                          createdAt: new Date("2026-08-27T00:00:00.000Z"),
                        },
                      ];
                    },
                  };
                }

                if (table === auditLogsTable) {
                  testState.auditValues = values;
                  if (testState.failAudit) {
                    return Promise.reject(new Error("audit insert failed"));
                  }
                  return Promise.resolve();
                }

                throw new Error("Unexpected transaction table");
              },
            }),
          };

          try {
            const result = await callback(transaction);
            testState.committedUser = result;
            return result;
          } catch (error) {
            testState.transactionRolledBack = true;
            testState.committedUser = null;
            throw error;
          }
        },
      ),
    },
  };
});

vi.mock("../lib/auth", () => ({
  ADMIN_ROLES: ["hospital_admin", "system_admin"],
  MANAGER_ROLES: [
    "supervisor",
    "department_manager",
    "hospital_admin",
    "system_admin",
  ],
  getUser: vi.fn(() => testState.actor),
  hashPassword: vi.fn(async () => "hashed-password"),
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole:
    (..._roles: string[]) =>
    (_req: Request, _res: Response, next: NextFunction) =>
      next(),
}));

vi.mock("../lib/roleHierarchy", () => ({
  canAssignRole: vi.fn(() => true),
  canManageTarget: vi.fn(() => true),
}));

vi.mock("../lib/helpers", () => ({
  computeEmployeeStats: vi.fn(),
  employeeSummary: vi.fn(),
  getCredentialScopedUsers: vi.fn(),
  getCredentialsFor: vi.fn(),
  getDepartments: vi.fn(),
  getPolicies: vi.fn(),
  getScopedUsers: vi.fn(),
  logAudit: testState.logAudit,
  serializeCredential: vi.fn(),
  serializeUser: vi.fn((user: Record<string, unknown>) => ({
    id: user.id,
    mustChangePassword: user.mustChangePassword,
  })),
}));

import router from "./employees";

describe("administrative employee provisioning", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  beforeEach(() => {
    testState.selectResults = [[], [{ id: 10 }]];
    testState.insertValues = null;
    testState.auditValues = null;
    testState.committedUser = null;
    testState.transactionCount = 0;
    testState.transactionRolledBack = false;
    testState.failAudit = false;
    testState.uniqueInsert = false;
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

  async function postEmployee(): Promise<globalThis.Response> {
    const app = express();
    app.use(express.json());
    app.use("/api", router);
    app.use(
      (
        _error: unknown,
        _req: Request,
        res: Response,
        _next: NextFunction,
      ) => {
        res.status(500).json({ message: "Internal server error" });
      },
    );
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a disposable TCP listener");
    }

    return fetch(`http://127.0.0.1:${address.port}/api/employees`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "New Worker",
        nameAr: "موظف جديد",
        email: "new.worker@example.sa",
        password: "temporary-pass-123",
        role: "employee",
        jobTitle: "Nurse",
        jobTitleAr: "ممرض",
        employeeNumber: "EMP-2",
      }),
    });
  }

  it("creates the account and audit event atomically with a forced password change", async () => {
    const response = await postEmployee();

    expect(response.status).toBe(201);
    expect(testState.transactionCount).toBe(1);
    expect(testState.insertValues).toEqual(
      expect.objectContaining({
        email: "new.worker@example.sa",
        passwordHash: "hashed-password",
        mustChangePassword: true,
      }),
    );
    expect(testState.auditValues).toEqual(
      expect.objectContaining({
        userId: 1,
        facilityId: 10,
        action: "Added employee",
        target: "New Worker",
      }),
    );
    expect(testState.committedUser).toEqual(
      expect.objectContaining({ id: 2, mustChangePassword: true }),
    );
    expect(testState.logAudit).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      id: 2,
      mustChangePassword: true,
    });
  });

  it("rolls the account insert back when the audit insert fails", async () => {
    testState.failAudit = true;

    const response = await postEmployee();

    expect(response.status).toBe(500);
    expect(testState.insertValues).not.toBeNull();
    expect(testState.auditValues).not.toBeNull();
    expect(testState.transactionRolledBack).toBe(true);
    expect(testState.committedUser).toBeNull();
  });

  it("maps a raced PostgreSQL unique violation to a private 409 response", async () => {
    testState.uniqueInsert = true;

    const response = await postEmployee();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      message: "Email already registered",
    });
    expect(testState.transactionRolledBack).toBe(true);
    expect(testState.committedUser).toBeNull();
    expect(testState.auditValues).toBeNull();
  });
});
