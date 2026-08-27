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
    departmentId: null,
    supervisorId: null,
    sessionVersion: 1,
    createdAt: new Date("2026-08-27T00:00:00.000Z"),
  },
  selectResults: [] as Array<Array<Record<string, unknown>>>,
  transactionCount: 0,
  transactionRolledBack: false,
  committedUpdate: null as Record<string, unknown> | null,
  committedAudit: null as Record<string, unknown> | null,
  failAudit: false,
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
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

  return {
    usersTable,
    auditLogsTable,
    credentialsTable: {},
    facilitiesTable: { id: "facilities.id" },
    departmentsTable: {
      id: "departments.id",
      facilityId: "departments.facilityId",
    },
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
            update: (table: unknown) => {
              set: (values: Record<string, unknown>) => {
                where: (condition: unknown) => PromiseLike<void> & {
                  returning: () => Promise<Array<Record<string, unknown>>>;
                };
              };
            };
            insert: (table: unknown) => {
              values: (values: Record<string, unknown>) => Promise<void>;
            };
          }) => Promise<unknown>,
        ) => {
          testState.transactionCount += 1;
          let stagedUpdate: Record<string, unknown> | null = null;
          let stagedAudit: Record<string, unknown> | null = null;

          const transaction = {
            update: (table: unknown) => {
              if (table !== usersTable)
                throw new Error("Unexpected update table");
              return {
                set: (values: Record<string, unknown>) => ({
                  where: (_condition: unknown) => {
                    stagedUpdate = { ...testState.target, ...values };
                    const completion = Promise.resolve() as Promise<void> & {
                      returning: () => Promise<Array<Record<string, unknown>>>;
                    };
                    completion.returning = async () => [stagedUpdate!];
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
    testState.actor.role = "hospital_admin";
    testState.target.role = "employee";
    testState.target.isActive = true;
    testState.selectResults = [];
    testState.transactionCount = 0;
    testState.transactionRolledBack = false;
    testState.committedUpdate = null;
    testState.committedAudit = null;
    testState.failAudit = false;
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

  it.each(["activate", "deactivate"])(
    "rejects a hidden %s API call from a non-admin manager",
    async (action) => {
      testState.actor.role = "department_manager";

      const response = await request("POST", `/employees/2/${action}`);

      expect(response.status).toBe(403);
      expect(testState.transactionCount).toBe(0);
    },
  );

  it("commits a profile update and its audit event in one transaction", async () => {
    const response = await request("PATCH", "/employees/2", {
      name: "Updated Employee",
    });

    expect(response.status).toBe(200);
    expect(testState.transactionCount).toBe(1);
    expect(testState.committedUpdate).toEqual(
      expect.objectContaining({ id: 2, name: "Updated Employee" }),
    );
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
    });

    expect(response.status).toBe(200);
    expect(testState.committedAudit).toEqual(
      expect.objectContaining({
        details: JSON.stringify({
          role: { from: "employee", to: "supervisor" },
        }),
      }),
    );
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
  ])(
    "rejects assigning an ineligible $label supervisor",
    async ({ supervisor }) => {
      testState.selectResults = [[supervisor]];

      const response = await request("PATCH", "/employees/2", {
        supervisorId: 3,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message:
          "Supervisor must be an active non-employee in the employee facility",
      });
      expect(testState.transactionCount).toBe(0);
    },
  );

  it("commits soft deletion and its audit event in one transaction", async () => {
    testState.selectResults = [[testState.target]];

    const response = await request("DELETE", "/employees/2");

    expect(response.status).toBe(204);
    expect(testState.transactionCount).toBe(1);
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
    testState.selectResults = [[testState.target]];
    testState.failAudit = true;

    const response = await request("DELETE", "/employees/2");

    expect(response.status).toBe(500);
    expect(testState.transactionRolledBack).toBe(true);
    expect(testState.committedUpdate).toBeNull();
    expect(testState.committedAudit).toBeNull();
  });

  it("commits account activation and its audit event in one transaction", async () => {
    testState.target.isActive = false;

    const response = await request("POST", "/employees/2/activate");

    expect(response.status).toBe(200);
    expect(testState.transactionCount).toBe(1);
    expect(testState.committedUpdate).toEqual(
      expect.objectContaining({ isActive: true }),
    );
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

    const response = await request("POST", "/employees/2/deactivate");

    expect(response.status).toBe(500);
    expect(testState.transactionRolledBack).toBe(true);
    expect(testState.committedUpdate).toBeNull();
    expect(testState.committedAudit).toBeNull();
  });
});
