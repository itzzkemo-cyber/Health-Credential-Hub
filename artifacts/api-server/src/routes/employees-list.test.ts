import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actor: {
    id: 1,
    role: "hospital_admin",
    facilityId: 10,
    isActive: true,
  },
  getCredentialScopedUsers: vi.fn(),
  getScopedUsers: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: {},
  usersTable: {},
  credentialsTable: {},
  facilitiesTable: {},
  departmentsTable: {},
  USER_ROLES: [
    "employee",
    "supervisor",
    "department_manager",
    "hospital_admin",
    "system_admin",
  ],
}));

vi.mock("../lib/auth", () => ({
  ADMIN_ROLES: ["hospital_admin", "system_admin"],
  MANAGER_ROLES: [
    "supervisor",
    "department_manager",
    "hospital_admin",
    "system_admin",
  ],
  getUser: vi.fn(() => mocks.actor),
  hashPassword: vi.fn(),
  requireAuth: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
  requireRole:
    (..._roles: string[]) =>
    (
      _req: express.Request,
      _res: express.Response,
      next: express.NextFunction,
    ) =>
      next(),
}));

vi.mock("../lib/helpers", () => ({
  computeEmployeeStats: vi.fn(() => ({
    complianceRate: 100,
    totalCredentials: 0,
    expiredCount: 0,
    expiringCount: 0,
    missingCount: 0,
    isAtRisk: false,
  })),
  employeeSummary: vi.fn(),
  getCredentialScopedUsers: mocks.getCredentialScopedUsers,
  getCredentialsFor: vi.fn(async () => []),
  getDepartments: vi.fn(async () => []),
  getPolicies: vi.fn(async () => []),
  getScopedUsers: mocks.getScopedUsers,
  logAudit: vi.fn(),
  serializeCredential: vi.fn(),
  serializeUser: vi.fn((user: { id: number; role: string }) => ({
    id: user.id,
    role: user.role,
  })),
}));

import router from "./employees";

describe("employee directory hierarchy", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  beforeEach(() => {
    mocks.getCredentialScopedUsers.mockReset();
    mocks.getScopedUsers.mockReset();
    mocks.getCredentialScopedUsers.mockResolvedValue([
      {
        ...mocks.actor,
        name: "Admin",
        nameAr: "مدير",
        email: "a@example.sa",
        employeeNumber: "A1",
      },
      {
        id: 2,
        role: "employee",
        facilityId: 10,
        isActive: true,
        name: "Employee",
        nameAr: "موظف",
        email: "e@example.sa",
        employeeNumber: "E1",
      },
    ]);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
  });

  it("uses strict self-plus-lower hierarchy scope for GET /employees", async () => {
    const app = express();
    app.use("/api", router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a disposable TCP listener");
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/employees`,
    );

    expect(response.status).toBe(200);
    expect(mocks.getCredentialScopedUsers).toHaveBeenCalledWith(mocks.actor);
    expect(mocks.getScopedUsers).not.toHaveBeenCalled();
    expect(await response.json()).toEqual([
      expect.objectContaining({ id: 1, role: "hospital_admin" }),
      expect.objectContaining({ id: 2, role: "employee" }),
    ]);
  });
});
