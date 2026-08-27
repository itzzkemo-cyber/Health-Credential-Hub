import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  actor: {
    id: 1,
    role: "system_admin",
    facilityId: 10,
    isActive: true,
  },
  departments: [
    {
      id: 100,
      name: "Facility 10 department",
      nameAr: "قسم المنشأة 10",
      facilityId: 10,
      headId: null,
      createdAt: new Date("2026-08-27T00:00:00.000Z"),
    },
    {
      id: 200,
      name: "Facility 20 department",
      nameAr: "قسم المنشأة 20",
      facilityId: 20,
      headId: null,
      createdAt: new Date("2026-08-27T00:00:00.000Z"),
    },
  ],
  users: [
    { id: 11, facilityId: 10, departmentId: 100, isActive: true },
    { id: 21, facilityId: 20, departmentId: 200, isActive: true },
  ],
  departmentConditions: [] as Array<{ column: unknown; value: unknown }>,
  getScopedUsers: vi.fn(),
  getCredentialsFor: vi.fn(),
  getPolicies: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
}));

vi.mock("@workspace/db", () => ({
  departmentsTable: { facilityId: "departments.facilityId" },
  usersTable: {},
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(
          async (condition: { column: unknown; value: unknown }) => {
            testState.departmentConditions.push(condition);
            return testState.departments.filter(
              (department) => department.facilityId === condition.value,
            );
          },
        ),
      })),
    })),
  },
}));

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
  computeEmployeeStats: vi.fn(() => ({
    expiredCount: 0,
    expiringCount: 0,
    complianceRate: 100,
  })),
  getCredentialsFor: testState.getCredentialsFor,
  getPolicies: testState.getPolicies,
  getScopedUsers: testState.getScopedUsers,
  logAudit: vi.fn(),
}));

import router from "./departments";

describe("department list facility scope", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  beforeEach(() => {
    testState.actor.role = "system_admin";
    testState.actor.facilityId = 10;
    testState.departmentConditions = [];
    testState.getScopedUsers.mockReset();
    testState.getScopedUsers.mockResolvedValue(testState.users);
    testState.getCredentialsFor.mockReset();
    testState.getCredentialsFor.mockResolvedValue([]);
    testState.getPolicies.mockReset();
    testState.getPolicies.mockResolvedValue([]);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
  });

  async function listDepartments(query = ""): Promise<globalThis.Response> {
    const app = express();
    app.use("/api", router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a disposable TCP listener");
    }
    return fetch(
      `http://127.0.0.1:${address.port}/api/departments${query}`,
    );
  }

  it("lets a system administrator request a target facility", async () => {
    const response = await listDepartments("?facilityId=20");

    expect(response.status).toBe(200);
    expect(testState.departmentConditions).toEqual([
      { column: "departments.facilityId", value: 20 },
    ]);
    expect(testState.getCredentialsFor).toHaveBeenCalledWith([21]);
    expect(testState.getPolicies).toHaveBeenCalledWith(20);
    expect(await response.json()).toEqual([
      expect.objectContaining({ id: 200, facilityId: 20 }),
    ]);
  });

  it("keeps a non-system administrator in their own facility when a selector is supplied", async () => {
    testState.actor.role = "hospital_admin";

    const response = await listDepartments("?facilityId=20");

    expect(response.status).toBe(200);
    expect(testState.departmentConditions).toEqual([
      { column: "departments.facilityId", value: 10 },
    ]);
    expect(testState.getCredentialsFor).toHaveBeenCalledWith([11]);
    expect(testState.getPolicies).toHaveBeenCalledWith(10);
    expect(await response.json()).toEqual([
      expect.objectContaining({ id: 100, facilityId: 10 }),
    ]);
  });

  it("ignores a malformed selector from a non-system administrator", async () => {
    testState.actor.role = "hospital_admin";

    const response = await listDepartments("?facilityId=not-a-number");

    expect(response.status).toBe(200);
    expect(testState.departmentConditions).toEqual([
      { column: "departments.facilityId", value: 10 },
    ]);
  });

  it("defaults an unfiltered system administrator request to their own facility", async () => {
    const response = await listDepartments();

    expect(response.status).toBe(200);
    expect(testState.departmentConditions).toEqual([
      { column: "departments.facilityId", value: 10 },
    ]);
  });

  it.each(["?facilityId=0", "?facilityId=abc", "?facilityId=20&facilityId=21"])(
    "rejects an invalid system administrator facility selector: %s",
    async (query) => {
      const response = await listDepartments(query);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message: "A valid facilityId is required",
      });
      expect(testState.departmentConditions).toHaveLength(0);
    },
  );
});
