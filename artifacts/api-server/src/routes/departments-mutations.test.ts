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
  committedDepartment: null as Record<string, unknown> | null,
  committedAudit: null as Record<string, unknown> | null,
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
          let stagedDetachedUsers = false;
          let stagedRetiredPolicies = false;
          const tx = {
            select: vi.fn(() => ({
              from: vi.fn((table: unknown) =>
                selection(
                  table === usersTable
                    ? [testState.actor]
                    : table === departmentsTable
                      ? [testState.department]
                      : [],
                ),
              ),
            })),
            insert: vi.fn((table: unknown) => ({
              values: vi.fn((values: Record<string, unknown>) => {
                if (table === auditLogsTable) {
                  if (testState.failAudit) {
                    return Promise.reject(new Error("audit insert failed"));
                  }
                  stagedAudit = values;
                  return Promise.resolve();
                }
                if (table !== departmentsTable)
                  throw new Error("Unexpected insert table");
                stagedDepartment = {
                  ...testState.department,
                  ...values,
                };
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
            testState.committedDetachedUsers = stagedDetachedUsers;
            testState.committedRetiredPolicies = stagedRetiredPolicies;
            return result;
          } catch (error) {
            testState.rolledBack = true;
            testState.committedDepartment = null;
            testState.committedAudit = null;
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
    testState.committedDepartment = null;
    testState.committedAudit = null;
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
