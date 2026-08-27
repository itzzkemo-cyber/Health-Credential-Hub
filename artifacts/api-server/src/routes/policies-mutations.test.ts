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
  policy: {
    id: 50,
    facilityId: 10,
    credentialType: "BLS",
    departmentId: null,
    roles: ["employee"],
    isRequired: true,
    deletedAt: null as Date | null,
    deletedBy: null as number | null,
    createdAt: new Date("2026-08-27T00:00:00.000Z"),
  },
  failAudit: false,
  committedPolicy: null as Record<string, unknown> | null,
  committedAudit: null as Record<string, unknown> | null,
  rolledBack: false,
  listConditions: [] as Array<Record<string, unknown>>,
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  isNull: vi.fn((column: unknown) => ({ column, isNull: true })),
}));

vi.mock("@workspace/db", () => {
  const usersTable = { id: "users.id" };
  const departmentsTable = {
    id: "departments.id",
    facilityId: "departments.facilityId",
    deletedAt: "departments.deletedAt",
  };
  const credentialPoliciesTable = {
    id: "policies.id",
    facilityId: "policies.facilityId",
    deletedAt: "policies.deletedAt",
  };
  const auditLogsTable = { kind: "audit" };

  function selection(rows: unknown[]) {
    const query = {
      where: vi.fn(() => query),
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
    CREDENTIAL_TYPES: ["BLS", "ACLS"],
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
          where: vi.fn(async (conditions: Array<Record<string, unknown>>) => {
            testState.listConditions = conditions;
            return [testState.policy];
          }),
        })),
      })),
      transaction: vi.fn(
        async (callback: (tx: unknown) => Promise<unknown>) => {
          let stagedPolicy: Record<string, unknown> | null = null;
          let stagedAudit: Record<string, unknown> | null = null;
          const tx = {
            select: vi.fn(() => ({
              from: vi.fn((table: unknown) =>
                selection(
                  table === usersTable
                    ? [testState.actor]
                    : table === credentialPoliciesTable
                      ? [testState.policy]
                      : [{ id: 100 }],
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
                if (table !== credentialPoliciesTable)
                  throw new Error("Unexpected insert table");
                stagedPolicy = { ...testState.policy, ...values };
                return { returning: async () => [stagedPolicy] };
              }),
            })),
            update: vi.fn((table: unknown) => {
              if (table !== credentialPoliciesTable)
                throw new Error("Unexpected update table");
              return {
                set: vi.fn((values: Record<string, unknown>) => ({
                  where: vi.fn(() => ({
                    returning: async () => {
                      stagedPolicy = { ...testState.policy, ...values };
                      return [stagedPolicy];
                    },
                  })),
                })),
              };
            }),
          };
          try {
            const result = await callback(tx);
            testState.committedPolicy = stagedPolicy;
            testState.committedAudit = stagedAudit;
            return result;
          } catch (error) {
            testState.rolledBack = true;
            testState.committedPolicy = null;
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
  getUser: vi.fn(() => testState.actor),
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole:
    (..._roles: string[]) =>
    (_req: Request, _res: Response, next: NextFunction) =>
      next(),
}));

import router from "./policies";

describe("policy mutation retention and audit atomicity", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  beforeEach(() => {
    testState.failAudit = false;
    testState.committedPolicy = null;
    testState.committedAudit = null;
    testState.rolledBack = false;
    testState.listConditions = [];
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
    method: "GET" | "POST" | "DELETE",
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

  it("lists only active policies in the authenticated facility", async () => {
    const response = await request("GET", "/policies");

    expect(response.status).toBe(200);
    expect(testState.listConditions).toEqual([
      { column: "policies.facilityId", value: 10 },
      { column: "policies.deletedAt", isNull: true },
    ]);
  });

  it("commits policy creation and audit together", async () => {
    const response = await request("POST", "/policies", {
      credentialType: "BLS",
      roles: ["employee", "employee"],
    });

    expect(response.status).toBe(201);
    expect(testState.committedPolicy).toEqual(
      expect.objectContaining({ facilityId: 10, roles: ["employee"] }),
    );
    expect(testState.committedAudit).toEqual(
      expect.objectContaining({ action: "Created policy", facilityId: 10 }),
    );
  });

  it("soft-deletes a policy and writes its audit in the same transaction", async () => {
    const response = await request("DELETE", "/policies/50");

    expect(response.status).toBe(204);
    expect(testState.committedPolicy).toEqual(
      expect.objectContaining({ deletedAt: expect.any(Date), deletedBy: 1 }),
    );
    expect(testState.committedAudit).toEqual(
      expect.objectContaining({ action: "Deleted policy", facilityId: 10 }),
    );
  });

  it("rolls policy soft deletion back when audit insertion fails", async () => {
    testState.failAudit = true;

    const response = await request("DELETE", "/policies/50");

    expect(response.status).toBe(500);
    expect(testState.rolledBack).toBe(true);
    expect(testState.committedPolicy).toBeNull();
    expect(testState.committedAudit).toBeNull();
  });
});
