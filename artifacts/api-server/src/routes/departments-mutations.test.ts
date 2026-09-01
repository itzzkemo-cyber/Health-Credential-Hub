import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  actor: {
    id: 1,
    email: "admin@example.test",
    passwordHash: "unused",
    name: "Facility Admin",
    nameAr: "مدير المنشأة",
    role: "hospital_admin",
    departmentId: null,
    supervisorId: null,
    facilityId: 10,
    jobTitle: "",
    jobTitleAr: "",
    employeeNumber: "A-1",
    phone: null,
    avatarUrl: null,
    googleId: null,
    isActive: true,
    mustChangePassword: false,
    sessionVersion: 0,
    totpSecret: null,
    totpEnabled: false,
    backupCodes: null,
    totpLastUsedStep: null,
    notificationPrefs: [],
    createdAt: new Date("2026-08-27T00:00:00.000Z"),
  },
  department: {
    id: 100,
    name: "Emergency",
    nameAr: "الطوارئ",
    facilityId: 10,
    headId: null,
    deletedAt: null as Date | null,
    deletedBy: null as number | null,
    createdAt: new Date("2026-08-27T00:00:00.000Z"),
  },
  failAudit: false,
  activeDepartmentNames: [] as Array<{
    id?: number;
    name: string;
    nameAr: string;
  }>,
  committedDepartment: null as Record<string, unknown> | null,
  committedAudit: null as Record<string, unknown> | null,
  committedDepartments: [] as Array<Record<string, unknown>>,
  committedAudits: [] as Array<Record<string, unknown>>,
  committedDetachedUsers: false,
  detachedUserValues: null as Record<string, unknown> | null,
  committedRetiredPolicies: false,
  rolledBack: false,
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  inArray: vi.fn((column: unknown, values: unknown[]) => ({ column, values })),
  isNull: vi.fn((column: unknown) => ({ column, isNull: true })),
  or: vi.fn((...conditions: unknown[]) => conditions),
  sql: vi.fn(() => "session-version-plus-one"),
}));

vi.mock("@workspace/db", () => {
  const usersTable = {
    id: "users.id",
    facilityId: "users.facilityId",
    departmentId: "users.departmentId",
    sessionVersion: "users.sessionVersion",
  };
  const departmentsTable = {
    id: "departments.id",
    name: "departments.name",
    nameAr: "departments.nameAr",
    facilityId: "departments.facilityId",
    deletedAt: "departments.deletedAt",
  };
  const credentialPoliciesTable = {
    id: "policies.id",
    facilityId: "policies.facilityId",
    departmentId: "policies.departmentId",
    deletedAt: "policies.deletedAt",
  };
  const auditLogsTable = { kind: "audit" };

  function selection(rows: unknown[]) {
    const query = {
      where: vi.fn(() => query),
      orderBy: vi.fn(() => query),
      for: vi.fn(async () => rows),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject),
    };
    return query;
  }

  return {
    usersTable,
    departmentsTable,
    credentialPoliciesTable,
    auditLogsTable,
    db: {
      transaction: vi.fn(
        async (callback: (tx: unknown) => Promise<unknown>) => {
          let stagedDepartment: Record<string, unknown> | null = null;
          let stagedAudit: Record<string, unknown> | null = null;
          const stagedDepartments: Array<Record<string, unknown>> = [];
          const stagedAudits: Array<Record<string, unknown>> = [];
          let stagedDetachedUsers = false;
          let stagedRetiredPolicies = false;
          const tx = {
            select: vi.fn((fields?: Record<string, unknown>) => ({
              from: vi.fn((table: unknown) =>
                selection(
                  table === usersTable
                    ? [testState.actor]
                    : table === departmentsTable
                      ? fields?.name === departmentsTable.name
                        ? testState.activeDepartmentNames
                        : [testState.department]
                      : [],
                ),
              ),
            })),
            execute: vi.fn(async () => []),
            insert: vi.fn((table: unknown) => ({
              values: vi.fn((values: Record<string, unknown>) => {
                if (table === auditLogsTable) {
                  if (testState.failAudit) {
                    return Promise.reject(new Error("audit insert failed"));
                  }
                  stagedAudit = values;
                  stagedAudits.push(values);
                  return Promise.resolve();
                }
                if (table !== departmentsTable)
                  throw new Error("Unexpected insert table");
                stagedDepartment = {
                  ...testState.department,
                  id: testState.department.id + stagedDepartments.length,
                  ...values,
                };
                stagedDepartments.push(stagedDepartment);
                return { returning: async () => [stagedDepartment] };
              }),
            })),
            update: vi.fn((table: unknown) => ({
              set: vi.fn((values: Record<string, unknown>) => ({
                where: vi.fn(() => ({
                  returning: async () => {
                    if (table === departmentsTable) {
                      stagedDepartment = {
                        ...testState.department,
                        ...values,
                      };
                      return [stagedDepartment];
                    }
                    if (table === usersTable) {
                      stagedDetachedUsers = true;
                      testState.detachedUserValues = values;
                      return [{ id: 2 }];
                    }
                    if (table === credentialPoliciesTable) {
                      stagedRetiredPolicies = true;
                      return [{ id: 9 }];
                    }
                    throw new Error("Unexpected update table");
                  },
                })),
              })),
            })),
          };
          try {
            const result = await callback(tx);
            testState.committedDepartment = stagedDepartment;
            testState.committedAudit = stagedAudit;
            testState.committedDepartments = stagedDepartments;
            testState.committedAudits = stagedAudits;
            testState.committedDetachedUsers = stagedDetachedUsers;
            testState.committedRetiredPolicies = stagedRetiredPolicies;
            return result;
          } catch (error) {
            testState.rolledBack = true;
            testState.committedDepartment = null;
            testState.committedAudit = null;
            testState.committedDepartments = [];
            testState.committedAudits = [];
            testState.committedDetachedUsers = false;
            testState.committedRetiredPolicies = false;
            throw error;
          }
        },
      ),
    },
  };
});

vi.mock("../lib/auth", () => ({
  ADMIN_ROLES: ["hospital_admin", "system_admin"],
  getUser: vi.fn(() => testState.actor),
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole:
    (..._roles: string[]) =>
    (_req: Request, _res: Response, next: NextFunction) =>
      next(),
}));

vi.mock("../lib/helpers", () => ({
  computeEmployeeStats: vi.fn(),
  getCredentialsFor: vi.fn(),
  getPolicies: vi.fn(),
  getScopedUsers: vi.fn(),
}));

import router from "./departments";

describe("department mutation retention and audit atomicity", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  beforeEach(() => {
    testState.failAudit = false;
    testState.activeDepartmentNames = [];
    testState.committedDepartment = null;
    testState.committedAudit = null;
    testState.committedDepartments = [];
    testState.committedAudits = [];
    testState.committedDetachedUsers = false;
    testState.detachedUserValues = null;
    testState.committedRetiredPolicies = false;
    testState.rolledBack = false;
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
    method: "POST" | "PATCH" | "DELETE",
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
    if (!address || typeof address === "string") throw new Error("No address");
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

  it("commits department creation and audit together", async () => {
    const response = await request("POST", "/departments", {
      name: "Emergency",
      nameAr: "الطوارئ",
    });

    expect(response.status).toBe(201);
    expect(testState.committedDepartment).toEqual(
      expect.objectContaining({ facilityId: 10, name: "Emergency" }),
    );
    expect(testState.committedAudit).toEqual(
      expect.objectContaining({ action: "Created department", facilityId: 10 }),
    );
  });

  it("rejects a normalized duplicate during single department creation", async () => {
    testState.activeDepartmentNames = [
      { name: "  EMERGENCY ", nameAr: "الطوارئ" },
    ];

    const response = await request("POST", "/departments", {
      name: " emergency ",
      nameAr: "قسم طوارئ آخر",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code: "department_name_conflict" }),
    );
    expect(testState.committedDepartments).toHaveLength(0);
    expect(testState.committedAudits).toHaveLength(0);
  });

  it("creates a facility-scoped batch while skipping existing and request duplicates", async () => {
    testState.activeDepartmentNames = [{ name: " ER ", nameAr: "الطوارئ" }];

    const response = await request("POST", "/departments/batch", {
      departments: [
        { name: "er", nameAr: "قسم طوارئ آخر" },
        { name: "2A", nameAr: "جناح 2A" },
        { name: " 2a ", nameAr: "جناح بديل" },
        { name: "OR", nameAr: "العمليات" },
        { name: "Endoscopy", nameAr: " العمليات " },
      ],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      created: [
        expect.objectContaining({ name: "2A", nameAr: "جناح 2A" }),
        expect.objectContaining({ name: "OR", nameAr: "العمليات" }),
      ],
      skipped: ["er", "2a", "Endoscopy"],
    });
    expect(testState.committedDepartments).toEqual([
      expect.objectContaining({ name: "2A", facilityId: 10, headId: null }),
      expect.objectContaining({ name: "OR", facilityId: 10, headId: null }),
    ]);
    expect(testState.committedAudits).toHaveLength(2);
    expect(testState.committedAudits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "Created department",
          facilityId: 10,
        }),
      ]),
    );
  });

  it("is idempotent when every requested department already exists", async () => {
    testState.activeDepartmentNames = [
      { name: "2A", nameAr: "جناح 2A" },
      { name: "OR", nameAr: "العمليات" },
    ];

    const response = await request("POST", "/departments/batch", {
      departments: [
        { name: "2a", nameAr: "جناح 2A" },
        { name: "OR", nameAr: "العمليات" },
      ],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      created: [],
      skipped: ["2a", "OR"],
    });
    expect(testState.committedDepartments).toHaveLength(0);
    expect(testState.committedAudits).toHaveLength(0);
  });

  it("rejects head assignments and unknown fields in a batch item", async () => {
    const response = await request("POST", "/departments/batch", {
      departments: [{ name: "IR", nameAr: "الأشعة التداخلية", headId: 7 }],
    });

    expect(response.status).toBe(400);
    expect(testState.committedDepartments).toHaveLength(0);
  });

  it("rolls the whole department batch back when an audit insert fails", async () => {
    testState.failAudit = true;

    const response = await request("POST", "/departments/batch", {
      departments: [
        { name: "IR", nameAr: "الأشعة التداخلية" },
        { name: "Endoscopy", nameAr: "المناظير" },
      ],
    });

    expect(response.status).toBe(500);
    expect(testState.rolledBack).toBe(true);
    expect(testState.committedDepartments).toHaveLength(0);
    expect(testState.committedAudits).toHaveLength(0);
  });

  it("commits department update and audit together", async () => {
    const response = await request("PATCH", "/departments/100", {
      name: "Emergency Care",
    });

    expect(response.status).toBe(200);
    expect(testState.committedDepartment).toEqual(
      expect.objectContaining({ name: "Emergency Care" }),
    );
    expect(testState.committedAudit).toEqual(
      expect.objectContaining({ action: "Updated department" }),
    );
  });

  it("rejects a normalized duplicate during department rename", async () => {
    testState.activeDepartmentNames = [
      { id: 101, name: "  EMERGENCY CARE ", nameAr: "العناية الطارئة" },
    ];

    const response = await request("PATCH", "/departments/100", {
      name: "emergency care",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code: "department_name_conflict" }),
    );
    expect(testState.committedDepartment).toBeNull();
    expect(testState.committedAudit).toBeNull();
  });

  it("soft-deletes the department, retires policies, detaches users, and audits atomically", async () => {
    const response = await request("DELETE", "/departments/100");

    expect(response.status).toBe(204);
    expect(testState.committedDepartment).toEqual(
      expect.objectContaining({ deletedAt: expect.any(Date), deletedBy: 1 }),
    );
    expect(testState.committedDetachedUsers).toBe(true);
    expect(testState.detachedUserValues).toEqual(
      expect.objectContaining({
        departmentId: null,
        sessionVersion: "session-version-plus-one",
      }),
    );
    expect(testState.committedRetiredPolicies).toBe(true);
    expect(testState.committedAudit).toEqual(
      expect.objectContaining({
        action: "Deleted department",
        details: JSON.stringify({
          detachedEmployeeCount: 1,
          retiredPolicyCount: 1,
        }),
      }),
    );
  });

  it("rolls soft deletion back if the audit insert fails", async () => {
    testState.failAudit = true;

    const response = await request("DELETE", "/departments/100");

    expect(response.status).toBe(500);
    expect(testState.rolledBack).toBe(true);
    expect(testState.committedDepartment).toBeNull();
    expect(testState.committedAudit).toBeNull();
    expect(testState.committedDetachedUsers).toBe(false);
    expect(testState.committedRetiredPolicies).toBe(false);
  });
});
