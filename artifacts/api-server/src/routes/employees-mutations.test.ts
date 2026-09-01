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
    departmentId: null as number | null,
    supervisorId: null as number | null,
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
    departmentId: null as number | null,
    supervisorId: null as number | null,
    isActive: true,
    sessionVersion: 4,
    passwordHash: "admin-password-hash",
    totpEnabled: true,
    totpSecret: "encrypted-secret",
    name: "Facility Admin",
    nameAr: "مدير المنشأة",
  },
  target: {
    id: 2,
    role: "employee",
    facilityId: 10,
    isActive: true,
    name: "Managed Employee",
    nameAr: "موظف مُدار",
    departmentId: null as number | null,
    supervisorId: null as number | null,
    sessionVersion: 1,
    phone: "+966500000000",
    phoneVerifiedAt: new Date("2026-08-27T01:00:00.000Z") as Date | null,
    createdAt: new Date("2026-08-27T00:00:00.000Z"),
  },
  extraUsers: [] as Array<Record<string, unknown>>,
  departmentRows: [{ id: 7, facilityId: 10 }] as Array<Record<string, unknown>>,
  lockSequence: [] as string[],
  lockedUserBatches: [] as Array<{
    ids: number[];
    orderBy: unknown;
    strength: string;
  }>,
  transactionCount: 0,
  transactionRolledBack: false,
  committedUpdate: null as Record<string, unknown> | null,
  committedAudit: null as Record<string, unknown> | null,
  updateCondition: null as unknown,
  failAudit: false,
  casConflict: false,
  sensitiveRequestCount: 0,
  sensitiveRequestMax: 0,
  consumeSecondFactor: vi.fn(async (_tx: unknown, actor: unknown) => actor),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  inArray: vi.fn((column: unknown, values: unknown[]) => ({ column, values })),
  isNull: vi.fn(),
  sql: vi.fn((strings: TemplateStringsArray) => strings.join("")),
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
  const auditLogsTable = { kind: "auditLogs" };
  const departmentsTable = {
    id: "departments.id",
    facilityId: "departments.facilityId",
    deletedAt: "departments.deletedAt",
  };

  return {
    usersTable,
    auditLogsTable,
    credentialsTable: {},
    facilitiesTable: { id: "facilities.id" },
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
        async (callback: (transaction: any) => Promise<unknown>) => {
          testState.transactionCount += 1;
          let stagedUpdate: Record<string, unknown> | null = null;
          let stagedAudit: Record<string, unknown> | null = null;

          const transaction = {
            select: (_selection?: unknown) => ({
              from: (table: unknown) => ({
                where: (condition: unknown) => {
                  if (table === usersTable) {
                    const ids =
                      typeof condition === "object" &&
                      condition !== null &&
                      "values" in condition &&
                      Array.isArray(condition.values)
                        ? (condition.values as number[])
                        : [];
                    return {
                      orderBy: (column: unknown) => ({
                        for: async (strength: string) => {
                          testState.lockSequence.push(`users:${strength}`);
                          testState.lockedUserBatches.push({
                            ids: [...ids],
                            orderBy: column,
                            strength,
                          });
                          return [
                            testState.lockedActor,
                            testState.target,
                            ...testState.extraUsers,
                          ]
                            .filter((entry) => ids.includes(entry.id as number))
                            .sort(
                              (left, right) =>
                                (left.id as number) - (right.id as number),
                            );
                        },
                      }),
                    };
                  }
                  if (table === departmentsTable) {
                    return {
                      for: async (strength: string) => {
                        testState.lockSequence.push(`department:${strength}`);
                        return testState.departmentRows;
                      },
                    };
                  }
                  throw new Error("Unexpected select table");
                },
              }),
            }),
            update: (table: unknown) => {
              if (table !== usersTable)
                throw new Error("Unexpected update table");
              return {
                set: (values: Record<string, unknown>) => ({
                  where: (condition: unknown) => {
                    testState.updateCondition = condition;
                    stagedUpdate = { ...testState.target, ...values };
                    const completion = Promise.resolve() as Promise<void> & {
                      returning: () => Promise<Array<Record<string, unknown>>>;
                    };
                    completion.returning = async () =>
                      testState.casConflict ? [] : [stagedUpdate!];
                    return completion;
                  },
                }),
              };
            },
            insert: (table: unknown) => ({
              values: async (values: Record<string, unknown>) => {
                if (table !== auditLogsTable) {
                  throw new Error("Unexpected insert table");
                }
                stagedAudit = values;
                if (testState.failAudit) throw new Error("audit insert failed");
              },
            }),
          };

          try {
            const result = await callback(transaction);
            testState.committedUpdate = stagedUpdate;
            testState.committedAudit = stagedAudit;
            return result;
          } catch (error) {
            testState.transactionRolledBack = true;
            testState.committedUpdate = null;
            testState.committedAudit = null;
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
  hashPassword: vi.fn(),
  comparePassword: vi.fn(
    async (password: string) => password === "admin-password",
  ),
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole:
    (...roles: string[]) =>
    (_req: Request, res: Response, next: NextFunction) => {
      if (!roles.includes(testState.actor.role)) {
        res.status(403).json({ message: "Forbidden" });
        return;
      }
      next();
    },
}));

vi.mock("../lib/secondFactor", () => ({
  consumeSecondFactor: testState.consumeSecondFactor,
}));

vi.mock("../lib/rateLimit", () => ({
  rateLimit: vi.fn((options: { max: number }) => {
    testState.sensitiveRequestMax = options.max;
    return (_req: Request, res: Response, next: NextFunction) => {
      testState.sensitiveRequestCount += 1;
      if (testState.sensitiveRequestCount > options.max) {
        res.setHeader("Retry-After", "600");
        res.status(429).json({
          code: "rate_limited",
          message: "Too many requests; try again later",
          messageAr: "طلبات كثيرة؛ حاول مرة أخرى لاحقًا",
        });
        return;
      }
      next();
    };
  }),
}));

vi.mock("../lib/helpers", () => ({
  computeEmployeeStats: vi.fn(),
  employeeSummary: vi.fn(),
  getCredentialScopedUsers: vi.fn(),
  getCredentialsFor: vi.fn(),
  getDepartments: vi.fn(),
  getPolicies: vi.fn(),
  getScopedUsers: vi.fn(async () => [testState.target]),
  serializeCredential: vi.fn(),
  serializeUser: vi.fn((user: Record<string, unknown>) => user),
}));

import router from "./employees";

describe("administrative employee mutations", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  beforeEach(() => {
    testState.actor.id = 1;
    testState.actor.role = "hospital_admin";
    testState.actor.facilityId = 10;
    testState.actor.departmentId = null;
    testState.actor.supervisorId = null;
    testState.actor.isActive = true;
    testState.actor.sessionVersion = 4;
    Object.assign(testState.lockedActor, testState.actor, {
      departmentId: null,
      supervisorId: null,
      sessionVersion: 4,
    });
    testState.target.id = 2;
    testState.target.role = "employee";
    testState.target.facilityId = 10;
    testState.target.departmentId = null;
    testState.target.supervisorId = null;
    testState.target.isActive = true;
    testState.target.sessionVersion = 1;
    testState.target.phone = "+966500000000";
    testState.target.phoneVerifiedAt = new Date("2026-08-27T01:00:00.000Z");
    testState.extraUsers = [];
    testState.departmentRows = [{ id: 7, facilityId: 10 }];
    testState.lockSequence = [];
    testState.lockedUserBatches = [];
    testState.transactionCount = 0;
    testState.transactionRolledBack = false;
    testState.committedUpdate = null;
    testState.committedAudit = null;
    testState.updateCondition = null;
    testState.failAudit = false;
    testState.casConflict = false;
    testState.sensitiveRequestCount = 0;
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

  async function request(
    method: "PATCH" | "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
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

    return fetch(`http://127.0.0.1:${address.port}/api${path}`, {
      method,
      ...(body
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
  }

  it("rejects changes to a verified phone until a dedicated re-verification flow exists", async () => {
    const response = await request("PATCH", "/employees/2", {
      phone: "+966511111111",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "phone_reverification_required" }),
    );
    expect(testState.transactionCount).toBe(1);
    expect(testState.committedUpdate).toBeNull();
  });

  it("accepts an unchanged phone echoed by an existing edit form", async () => {
    const response = await request("PATCH", "/employees/2", {
      phone: "+966500000000",
    });

    expect(response.status).toBe(200);
    expect(testState.transactionCount).toBe(1);
    expect(testState.committedUpdate).toBeNull();
  });

  it("allows a valid unverified phone correction and keeps it unverified", async () => {
    testState.target.phoneVerifiedAt = null;

    const response = await request("PATCH", "/employees/2", {
      phone: "+966511111111",
    });

    expect(response.status).toBe(200);
    expect(testState.committedUpdate).toEqual(
      expect.objectContaining({
        phone: "+966511111111",
        phoneVerifiedAt: null,
      }),
    );
  });

  it("allows clearing an unverified phone", async () => {
    testState.target.phoneVerifiedAt = null;

    const response = await request("PATCH", "/employees/2", { phone: null });

    expect(response.status).toBe(200);
    expect(testState.committedUpdate).toEqual(
      expect.objectContaining({ phone: null, phoneVerifiedAt: null }),
    );
  });

  it("rejects a malformed unverified phone", async () => {
    testState.target.phoneVerifiedAt = null;

    const response = await request("PATCH", "/employees/2", {
      phone: "0500000000",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "invalid_phone" }),
    );
    expect(testState.committedUpdate).toBeNull();
  });

  it.each(["activate", "deactivate"])(
    "rejects a hidden %s API call from a non-admin manager",
    async (action) => {
      testState.actor.role = "department_manager";

      const response = await request("POST", `/employees/2/${action}`);

      expect(response.status).toBe(403);
      expect(testState.transactionCount).toBe(0);
    },
  );

  it("rejects an invalid employee identifier before opening a transaction", async () => {
    const response = await request("PATCH", "/employees/not-an-id", {
      name: "Invalid Target",
    });

    expect(response.status).toBe(404);
    expect(testState.transactionCount).toBe(0);
  });

  it("rate limits repeated employee account-state step-up attempts before opening a transaction", async () => {
    testState.sensitiveRequestCount = testState.sensitiveRequestMax;

    const response = await request("POST", "/employees/2/deactivate", {
      currentPassword: "wrong-password",
      code: "000000",
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("600");
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "rate_limited" }),
    );
    expect(testState.transactionCount).toBe(0);
    expect(testState.consumeSecondFactor).not.toHaveBeenCalled();
  });

  it("does not spend the step-up attempt budget on a profile-only PATCH", async () => {
    testState.sensitiveRequestCount = testState.sensitiveRequestMax;

    const response = await request("PATCH", "/employees/2", {
      name: "Updated Employee",
    });

    expect(response.status).toBe(200);
    expect(testState.sensitiveRequestCount).toBe(testState.sensitiveRequestMax);
  });

  it("commits a profile update and its audit event in one transaction", async () => {
    const response = await request("PATCH", "/employees/2", {
      name: "Updated Employee",
    });

    expect(response.status).toBe(200);
    expect(testState.transactionCount).toBe(1);
    expect(testState.lockedUserBatches).toEqual([
      { ids: [1, 2], orderBy: "users.id", strength: "update" },
    ]);
    expect(testState.committedUpdate).toEqual(
      expect.objectContaining({ id: 2, name: "Updated Employee" }),
    );
    expect(testState.updateCondition).toEqual([
      { column: "users.id", value: 2 },
      { column: "users.sessionVersion", value: 1 },
    ]);
    expect(testState.committedAudit).toEqual(
      expect.objectContaining({
        action: "Updated employee",
        target: "Updated Employee",
        facilityId: 10,
      }),
    );
  });

  it("rolls a profile update back when its audit insert fails", async () => {
    testState.failAudit = true;

    const response = await request("PATCH", "/employees/2", {
      name: "Uncommitted Employee",
    });

    expect(response.status).toBe(500);
    expect(testState.transactionRolledBack).toBe(true);
    expect(testState.committedUpdate).toBeNull();
    expect(testState.committedAudit).toBeNull();
  });

  it("records a non-sensitive old/new role change in the atomic audit", async () => {
    const response = await request("PATCH", "/employees/2", {
      role: "supervisor",
      currentPassword: "admin-password",
      code: "123456",
    });

    expect(response.status).toBe(200);
    expect(testState.committedUpdate?.sessionVersion).not.toBe(1);
    expect(testState.consumeSecondFactor).toHaveBeenCalledOnce();
    expect(testState.committedAudit).toEqual(
      expect.objectContaining({
        details: JSON.stringify({
          role: { from: "employee", to: "supervisor" },
        }),
      }),
    );
  });

  it("requires atomic supervisor revalidation when changing a role with an existing supervisor", async () => {
    testState.target.supervisorId = 3;

    const response = await request("PATCH", "/employees/2", {
      role: "supervisor",
      currentPassword: "admin-password",
      code: "123456",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "supervisor_revalidation_required",
      message:
        "Include supervisorId when changing the role of an employee who already has a supervisor",
      messageAr: "أرسل معرّف المشرف عند تغيير دور موظف لديه مشرف حاليًا",
    });
    expect(testState.lockedUserBatches).toEqual([
      { ids: [1, 2], orderBy: "users.id", strength: "update" },
    ]);
    expect(testState.committedUpdate).toBeNull();
    expect(testState.committedAudit).toBeNull();
    expect(testState.consumeSecondFactor).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "employee",
      targetRole: "employee",
      supervisor: { id: 3, role: "employee", isActive: true },
    },
    {
      label: "inactive manager",
      targetRole: "employee",
      supervisor: { id: 3, role: "supervisor", isActive: false },
    },
    {
      label: "equal-ranked manager",
      targetRole: "supervisor",
      supervisor: { id: 3, role: "supervisor", isActive: true },
    },
    {
      label: "lower-ranked manager",
      targetRole: "department_manager",
      supervisor: { id: 3, role: "supervisor", isActive: true },
    },
    {
      label: "cross-facility manager",
      targetRole: "employee",
      supervisor: {
        id: 3,
        role: "supervisor",
        isActive: true,
        facilityId: 99,
      },
    },
  ])(
    "rejects assigning an ineligible $label supervisor",
    async ({ supervisor, targetRole }) => {
      testState.target.role = targetRole;
      testState.extraUsers = [
        { facilityId: 10, ...supervisor, sessionVersion: 1 },
      ];

      const response = await request("PATCH", "/employees/2", {
        supervisorId: 3,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message:
          "Supervisor must be an active higher-ranked account in the employee facility",
      });
      expect(testState.transactionCount).toBe(1);
      expect(testState.committedUpdate).toBeNull();
    },
  );

  it("commits soft deletion and its audit event in one transaction", async () => {
    const response = await request("DELETE", "/employees/2", {
      currentPassword: "admin-password",
      code: "123456",
    });

    expect(response.status).toBe(204);
    expect(testState.transactionCount).toBe(1);
    expect(testState.consumeSecondFactor).toHaveBeenCalledOnce();
    expect(testState.committedUpdate).toEqual(
      expect.objectContaining({ isActive: false }),
    );
    expect(testState.committedAudit).toEqual(
      expect.objectContaining({
        action: "Deactivated employee",
        details: JSON.stringify({
          isActive: { from: true, to: false },
        }),
      }),
    );
  });

  it("rolls soft deletion back when its audit insert fails", async () => {
    testState.failAudit = true;

    const response = await request("DELETE", "/employees/2", {
      currentPassword: "admin-password",
      code: "123456",
    });

    expect(response.status).toBe(500);
    expect(testState.transactionRolledBack).toBe(true);
    expect(testState.committedUpdate).toBeNull();
    expect(testState.committedAudit).toBeNull();
  });

  it("commits account activation and its audit event in one transaction", async () => {
    testState.target.isActive = false;

    const response = await request("POST", "/employees/2/activate", {
      currentPassword: "admin-password",
      code: "123456",
    });

    expect(response.status).toBe(200);
    expect(testState.transactionCount).toBe(1);
    expect(testState.consumeSecondFactor).toHaveBeenCalledOnce();
    expect(testState.committedUpdate).toEqual(
      expect.objectContaining({ isActive: true }),
    );
    expect(testState.committedUpdate?.sessionVersion).not.toBe(1);
    expect(testState.committedAudit).toEqual(
      expect.objectContaining({
        action: "Activated employee",
        details: JSON.stringify({
          isActive: { from: false, to: true },
        }),
      }),
    );
  });

  it("rolls account deactivation back when its audit insert fails", async () => {
    testState.failAudit = true;

    const response = await request("POST", "/employees/2/deactivate", {
      currentPassword: "admin-password",
      code: "123456",
    });

    expect(response.status).toBe(500);
    expect(testState.transactionRolledBack).toBe(true);
    expect(testState.committedUpdate).toBeNull();
    expect(testState.committedAudit).toBeNull();
  });

  it("locks actor, target, and proposed supervisor together in stable ID order", async () => {
    testState.actor.id = 9;
    testState.lockedActor.id = 9;
    testState.extraUsers = [
      {
        id: 3,
        role: "supervisor",
        facilityId: 10,
        isActive: true,
        sessionVersion: 2,
      },
    ];

    const response = await request("PATCH", "/employees/2", {
      supervisorId: 3,
      currentPassword: "admin-password",
      code: "123456",
    });

    expect(response.status).toBe(200);
    expect(testState.committedUpdate?.sessionVersion).not.toBe(1);
    expect(testState.lockedUserBatches).toEqual([
      { ids: [2, 3, 9], orderBy: "users.id", strength: "update" },
    ]);
  });

  it("locks the proposed department before users and rechecks its facility", async () => {
    const response = await request("PATCH", "/employees/2", {
      departmentId: 7,
      currentPassword: "admin-password",
      code: "123456",
    });

    expect(response.status).toBe(200);
    expect(testState.lockSequence).toEqual([
      "department:key share",
      "users:update",
    ]);
    expect(testState.committedUpdate).toEqual(
      expect.objectContaining({ departmentId: 7 }),
    );
    expect(testState.committedUpdate?.sessionVersion).not.toBe(1);
  });

  it("requires MFA step-up before an actual organizational change", async () => {
    const response = await request("PATCH", "/employees/2", {
      role: "supervisor",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "step_up_failed" }),
    );
    expect(testState.committedUpdate).toBeNull();
    expect(testState.committedAudit).toBeNull();
  });

  it.each([
    {
      label: "PATCH isActive",
      method: "PATCH" as const,
      path: "/employees/2",
      body: { isActive: false },
      targetIsActive: true,
    },
    {
      label: "soft deletion",
      method: "DELETE" as const,
      path: "/employees/2",
      body: undefined,
      targetIsActive: true,
    },
    {
      label: "activation",
      method: "POST" as const,
      path: "/employees/2/activate",
      body: undefined,
      targetIsActive: false,
    },
    {
      label: "deactivation",
      method: "POST" as const,
      path: "/employees/2/deactivate",
      body: undefined,
      targetIsActive: true,
    },
  ])(
    "requires administrator step-up for $label",
    async ({ method, path, body, targetIsActive }) => {
      testState.target.isActive = targetIsActive;

      const response = await request(method, path, body);

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(
        expect.objectContaining({ code: "step_up_failed" }),
      );
      expect(testState.consumeSecondFactor).not.toHaveBeenCalled();
      expect(testState.committedUpdate).toBeNull();
      expect(testState.committedAudit).toBeNull();
    },
  );

  it("requires an enrolled administrator second factor before deactivation", async () => {
    testState.lockedActor.totpEnabled = false;
    testState.lockedActor.totpSecret = null as unknown as string;

    const response = await request("POST", "/employees/2/deactivate", {
      currentPassword: "admin-password",
      code: "123456",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "admin_mfa_required" }),
    );
    expect(testState.consumeSecondFactor).not.toHaveBeenCalled();
    expect(testState.committedUpdate).toBeNull();
  });

  it("verifies the administrator password before consuming the second factor", async () => {
    const response = await request("POST", "/employees/2/deactivate", {
      currentPassword: "wrong-password",
      code: "123456",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "step_up_failed" }),
    );
    expect(testState.consumeSecondFactor).not.toHaveBeenCalled();
    expect(testState.committedUpdate).toBeNull();
  });

  it("rejects a replayed second factor without changing the employee", async () => {
    testState.consumeSecondFactor.mockResolvedValueOnce(null);

    const response = await request("DELETE", "/employees/2", {
      currentPassword: "admin-password",
      code: "123456",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "step_up_failed" }),
    );
    expect(testState.consumeSecondFactor).toHaveBeenCalledOnce();
    expect(testState.committedUpdate).toBeNull();
    expect(testState.committedAudit).toBeNull();
  });

  it("requires and consumes step-up for PATCH activation state changes", async () => {
    const response = await request("PATCH", "/employees/2", {
      isActive: false,
      currentPassword: "admin-password",
      code: "123456",
    });

    expect(response.status).toBe(200);
    expect(testState.consumeSecondFactor).toHaveBeenCalledOnce();
    expect(testState.committedUpdate).toEqual(
      expect.objectContaining({ isActive: false }),
    );
    expect(testState.committedUpdate?.sessionVersion).not.toBe(1);
  });

  it("does not rotate the target session on an idempotent active-state request", async () => {
    const response = await request("POST", "/employees/2/activate", {
      currentPassword: "admin-password",
      code: "123456",
    });

    expect(response.status).toBe(200);
    expect(testState.consumeSecondFactor).toHaveBeenCalledOnce();
    expect(testState.committedUpdate).toBeNull();
    expect(testState.committedAudit).toBeNull();
  });

  it("rejects a stale administrator session after the locked actor was demoted", async () => {
    testState.lockedActor.role = "department_manager";

    const response = await request("DELETE", "/employees/2");

    expect(response.status).toBe(403);
    expect(testState.transactionCount).toBe(1);
    expect(testState.committedUpdate).toBeNull();
    expect(testState.committedAudit).toBeNull();
  });

  it("rejects a mutation after the locked actor was deactivated", async () => {
    testState.lockedActor.isActive = false;

    const response = await request("PATCH", "/employees/2", {
      name: "Must Not Commit",
    });

    expect(response.status).toBe(401);
    expect(testState.committedUpdate).toBeNull();
  });

  it("rejects a mutation after the actor session was revoked", async () => {
    testState.lockedActor.sessionVersion = 5;

    const response = await request("POST", "/employees/2/deactivate");

    expect(response.status).toBe(401);
    expect(testState.committedUpdate).toBeNull();
    expect(testState.committedAudit).toBeNull();
  });

  it("rechecks the locked target facility instead of trusting pre-transaction scope", async () => {
    testState.target.facilityId = 11;

    const response = await request("PATCH", "/employees/2", {
      name: "Cross Facility",
    });

    expect(response.status).toBe(404);
    expect(testState.committedUpdate).toBeNull();
  });

  it("rechecks a department manager's team scope from the locked rows", async () => {
    testState.actor.role = "department_manager";
    testState.actor.departmentId = 5;
    testState.lockedActor.role = "department_manager";
    testState.lockedActor.departmentId = 5;
    testState.target.departmentId = 6;

    const response = await request("PATCH", "/employees/2", {
      name: "Other Department",
    });

    expect(response.status).toBe(404);
    expect(testState.committedUpdate).toBeNull();
    expect(testState.committedAudit).toBeNull();
  });

  it.each([
    {
      label: "PATCH",
      method: "PATCH" as const,
      path: "/employees/2",
      body: { name: "Hidden Peer" },
    },
    {
      label: "DELETE",
      method: "DELETE" as const,
      path: "/employees/2",
      body: undefined,
    },
    {
      label: "activation",
      method: "POST" as const,
      path: "/employees/2/activate",
      body: undefined,
    },
    {
      label: "deactivation",
      method: "POST" as const,
      path: "/employees/2/deactivate",
      body: undefined,
    },
  ])(
    "returns the same not-found response for a hidden peer on $label",
    async ({ method, path, body }) => {
      testState.target.role = "hospital_admin";

      const response = await request(method, path, body);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ message: "Employee not found" });
      expect(testState.committedUpdate).toBeNull();
      expect(testState.committedAudit).toBeNull();
    },
  );

  it("returns a conflict and omits the audit when the conditional update loses CAS", async () => {
    testState.casConflict = true;

    const response = await request("PATCH", "/employees/2", {
      name: "Conflicting Employee",
    });

    expect(response.status).toBe(409);
    expect(testState.committedAudit).toBeNull();
  });
});
