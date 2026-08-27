import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  actor: {
    id: 1,
    role: "hospital_admin",
    facilityId: 10,
    isActive: true,
    sessionVersion: 4,
    passwordHash: "admin-password-hash",
    totpEnabled: true,
    totpSecret: "encrypted-secret",
    name: "Facility Admin",
    nameAr: "مدير المنشأة",
  },
  lockedActor: {
    id: 1,
    role: "hospital_admin",
    facilityId: 10,
    isActive: true,
    sessionVersion: 4,
    passwordHash: "admin-password-hash",
    totpEnabled: true,
    totpSecret: "encrypted-secret",
    name: "Facility Admin",
    nameAr: "مدير المنشأة",
  },
  extraUsers: [] as Array<Record<string, unknown>>,
  departmentRows: [] as Array<Record<string, unknown>>,
  facilityRows: [{ id: 10 }] as Array<Record<string, unknown>>,
  existingEmailRows: [] as Array<Record<string, unknown>>,
  lockSequence: [] as string[],
  lockedUserIds: [] as number[],
  insertValues: null as Record<string, unknown> | null,
  auditValues: null as Record<string, unknown> | null,
  committedUser: null as Record<string, unknown> | null,
  transactionCount: 0,
  transactionRolledBack: false,
  failAudit: false,
  uniqueInsert: false,
  logAudit: vi.fn(async () => undefined),
  consumeSecondFactor: vi.fn(async (_tx: unknown, actor: unknown) => actor),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  gt: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  inArray: vi.fn((column: unknown, values: unknown[]) => ({ column, values })),
  isNull: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("@workspace/db", () => {
  const usersTable = {
    id: "users.id",
    email: "users.email",
    facilityId: "users.facilityId",
    role: "users.role",
    isActive: "users.isActive",
    sessionVersion: "users.sessionVersion",
  };
  const facilitiesTable = { id: "facilities.id" };
  const auditLogsTable = { kind: "auditLogs" };
  const departmentsTable = {
    id: "departments.id",
    facilityId: "departments.facilityId",
    deletedAt: "departments.deletedAt",
  };
  return {
    usersTable,
    credentialsTable: {},
    facilitiesTable,
    auditLogsTable,
    departmentsTable,
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
          where: vi.fn(async () => []),
        })),
      })),
      transaction: vi.fn(
        async (
          callback: (transaction: any) => Promise<Record<string, unknown>>,
        ) => {
          testState.transactionCount += 1;
          const transaction = {
            select: (_selection?: unknown) => ({
              from: (table: unknown) => ({
                where: (condition: unknown) => {
                  if (table === departmentsTable) {
                    return {
                      for: async (strength: string) => {
                        testState.lockSequence.push(`department:${strength}`);
                        return testState.departmentRows;
                      },
                    };
                  }
                  if (table === usersTable) {
                    if (
                      typeof condition === "object" &&
                      condition !== null &&
                      "values" in condition &&
                      Array.isArray(condition.values)
                    ) {
                      const ids = condition.values as number[];
                      return {
                        orderBy: (_column: unknown) => ({
                          for: async (strength: string) => {
                            testState.lockSequence.push(`users:${strength}`);
                            testState.lockedUserIds = [...ids];
                            return [
                              testState.lockedActor,
                              ...testState.extraUsers,
                            ]
                              .filter((entry) =>
                                ids.includes(entry.id as number),
                              )
                              .sort(
                                (left, right) =>
                                  (left.id as number) - (right.id as number),
                              );
                          },
                        }),
                      };
                    }
                    return Promise.resolve(testState.existingEmailRows);
                  }
                  if (table === facilitiesTable) {
                    return Promise.resolve(testState.facilityRows);
                  }
                  throw new Error("Unexpected select table");
                },
              }),
            }),
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
            testState.committedUser =
              result.kind === "created"
                ? (result.user as Record<string, unknown>)
                : null;
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
  comparePassword: vi.fn(async (password: string) => password === "admin-password"),
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole:
    (..._roles: string[]) =>
    (_req: Request, _res: Response, next: NextFunction) =>
      next(),
}));

vi.mock("../lib/secondFactor", () => ({
  consumeSecondFactor: testState.consumeSecondFactor,
}));

vi.mock("../lib/roleHierarchy", () => ({
  canAssignRole: vi.fn(() => true),
  canManageTarget: vi.fn(() => true),
  isUserInScope: vi.fn(() => true),
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
    Object.assign(testState.actor, {
      id: 1,
      role: "hospital_admin",
      facilityId: 10,
      isActive: true,
      sessionVersion: 4,
    });
    Object.assign(testState.lockedActor, testState.actor);
    testState.extraUsers = [];
    testState.departmentRows = [];
    testState.facilityRows = [{ id: 10 }];
    testState.existingEmailRows = [];
    testState.lockSequence = [];
    testState.lockedUserIds = [];
    testState.insertValues = null;
    testState.auditValues = null;
    testState.committedUser = null;
    testState.transactionCount = 0;
    testState.transactionRolledBack = false;
    testState.failAudit = false;
    testState.uniqueInsert = false;
    testState.logAudit.mockClear();
    testState.consumeSecondFactor.mockClear();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
  });

  async function postEmployee(
    overrides: Record<string, unknown> = {},
  ): Promise<globalThis.Response> {
    const app = express();
    app.use(express.json());
    app.use("/api", router);
    app.use(
      (_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
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
        ...overrides,
      }),
    });
  }

  it("creates the account and audit event atomically with a forced password change", async () => {
    const response = await postEmployee();

    expect(response.status).toBe(201);
    expect(testState.transactionCount).toBe(1);
    expect(testState.lockSequence).toEqual(["users:update"]);
    expect(testState.lockedUserIds).toEqual([1]);
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

  it("requires and consumes MFA step-up before provisioning a manager role", async () => {
    const response = await postEmployee({
      role: "supervisor",
      currentPassword: "admin-password",
      code: "123456",
    });

    expect(response.status).toBe(201);
    expect(testState.consumeSecondFactor).toHaveBeenCalledOnce();
    expect(testState.insertValues).toEqual(
      expect.objectContaining({ role: "supervisor" }),
    );
  });

  it("rejects privileged provisioning without administrator MFA", async () => {
    testState.lockedActor.totpEnabled = false;
    testState.lockedActor.totpSecret = null as unknown as string;

    const response = await postEmployee({ role: "supervisor" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "admin_mfa_required" }),
    );
    expect(testState.insertValues).toBeNull();
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

  it.each([
    {
      label: "employee",
      supervisor: { id: 3, role: "employee", isActive: true },
    },
    {
      label: "inactive manager",
      supervisor: { id: 3, role: "supervisor", isActive: false },
    },
  ])("rejects an ineligible $label supervisor", async ({ supervisor }) => {
    testState.extraUsers = [
      { ...supervisor, facilityId: 10, sessionVersion: 1 },
    ];

    const response = await postEmployee({ supervisorId: 3 });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message:
        "Supervisor must be an active non-employee in the target facility",
    });
    expect(testState.transactionCount).toBe(1);
    expect(testState.insertValues).toBeNull();
    expect(testState.auditValues).toBeNull();
  });

  it("locks the target department before actor and supervisor users", async () => {
    testState.departmentRows = [{ id: 7, facilityId: 10 }];
    testState.extraUsers = [
      {
        id: 3,
        role: "supervisor",
        facilityId: 10,
        isActive: true,
        sessionVersion: 2,
      },
    ];

    const response = await postEmployee({
      departmentId: 7,
      supervisorId: 3,
    });

    expect(response.status).toBe(201);
    expect(testState.lockSequence).toEqual([
      "department:key share",
      "users:update",
    ]);
    expect(testState.lockedUserIds).toEqual([1, 3]);
    expect(testState.insertValues).toEqual(
      expect.objectContaining({ departmentId: 7, supervisorId: 3 }),
    );
  });

  it("does not provision into a department retired before the transaction lock", async () => {
    testState.departmentRows = [];

    const response = await postEmployee({ departmentId: 7 });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: "Department not found in the target facility",
    });
    expect(testState.lockSequence).toEqual([
      "department:key share",
      "users:update",
    ]);
    expect(testState.insertValues).toBeNull();
    expect(testState.auditValues).toBeNull();
  });

  it("rechecks the locked actor role and session before exposing or inserting data", async () => {
    testState.lockedActor.role = "department_manager";
    testState.existingEmailRows = [{ id: 99 }];

    const response = await postEmployee();

    expect(response.status).toBe(403);
    expect(testState.insertValues).toBeNull();
    expect(testState.auditValues).toBeNull();
  });

  it("uses the locked hospital administrator facility instead of stale middleware scope", async () => {
    testState.lockedActor.facilityId = 11;
    testState.facilityRows = [{ id: 11 }];

    const response = await postEmployee();

    expect(response.status).toBe(201);
    expect(testState.insertValues).toEqual(
      expect.objectContaining({ facilityId: 11 }),
    );
    expect(testState.auditValues).toEqual(
      expect.objectContaining({ facilityId: 11 }),
    );
  });

  it("checks existing email only after the locked actor authorization", async () => {
    testState.existingEmailRows = [{ id: 99 }];

    const response = await postEmployee();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      message: "Email already registered",
    });
    expect(testState.transactionCount).toBe(1);
    expect(testState.insertValues).toBeNull();
  });
});
