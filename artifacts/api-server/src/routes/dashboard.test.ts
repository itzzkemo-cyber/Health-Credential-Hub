import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dashboardMocks = vi.hoisted(() => ({
  currentUser: {
    id: 3,
    role: "hospital_admin",
    facilityId: 20,
  },
  scopedUserIds: [3, 7],
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  where: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: dashboardMocks.and,
  desc: vi.fn((column: unknown) => ({ kind: "desc", column })),
  eq: dashboardMocks.eq,
  inArray: dashboardMocks.inArray,
}));

vi.mock("@workspace/db", () => {
  const auditLogsTable = {
    userId: "auditLogs.userId",
    facilityId: "auditLogs.facilityId",
    createdAt: "auditLogs.createdAt",
  };
  return {
    auditLogsTable,
    db: {
      select: vi.fn(() => {
        const query = {
          from: vi.fn(() => query),
          where: dashboardMocks.where,
          orderBy: vi.fn(() => query),
          limit: vi.fn(async () => []),
        };
        dashboardMocks.where.mockReturnValue(query);
        return query;
      }),
    },
  };
});

vi.mock("../lib/auth", () => ({
  getUser: vi.fn(() => dashboardMocks.currentUser),
  requireAuth: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

vi.mock("../lib/helpers", () => ({
  computeEmployeeStats: vi.fn(),
  computeStatus: vi.fn(),
  daysUntil: vi.fn(),
  getCredentialsFor: vi.fn(),
  getDepartments: vi.fn(),
  getPolicies: vi.fn(),
  getScopedUsers: vi.fn(async () =>
    dashboardMocks.scopedUserIds.map((id) => ({ id, isActive: true })),
  ),
  serializeCredential: vi.fn(),
}));

import router from "./dashboard";

describe("dashboard recent activity tenant scope", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  beforeEach(() => {
    dashboardMocks.currentUser.role = "hospital_admin";
    dashboardMocks.currentUser.facilityId = 20;
    dashboardMocks.scopedUserIds = [3, 7];
    dashboardMocks.and.mockReset();
    dashboardMocks.eq.mockReset();
    dashboardMocks.inArray.mockReset();
    dashboardMocks.where.mockClear();
    dashboardMocks.inArray.mockImplementation((column, values) => ({
      kind: "inArray",
      column,
      values,
    }));
    dashboardMocks.eq.mockImplementation((column, value) => ({
      kind: "eq",
      column,
      value,
    }));
    dashboardMocks.and.mockImplementation((...conditions) => ({
      kind: "and",
      conditions,
    }));
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
  });

  async function requestActivity(): Promise<Response> {
    const app = express();
    app.use("/api", router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a disposable TCP listener");
    }
    return fetch(
      `http://127.0.0.1:${address.port}/api/dashboard/activity`,
    );
  }

  it("combines scoped actor ids with the audit event facility", async () => {
    const response = await requestActivity();

    expect(response.status).toBe(200);
    expect(dashboardMocks.inArray).toHaveBeenCalledWith(
      "auditLogs.userId",
      dashboardMocks.scopedUserIds,
    );
    expect(dashboardMocks.eq).toHaveBeenCalledWith(
      "auditLogs.facilityId",
      dashboardMocks.currentUser.facilityId,
    );
    expect(dashboardMocks.where).toHaveBeenCalledWith({
      kind: "and",
      conditions: [
        {
          kind: "inArray",
          column: "auditLogs.userId",
          values: dashboardMocks.scopedUserIds,
        },
        {
          kind: "eq",
          column: "auditLogs.facilityId",
          value: dashboardMocks.currentUser.facilityId,
        },
      ],
    });
  });

  it("keeps system administrator activity global without a facility predicate", async () => {
    dashboardMocks.currentUser.role = "system_admin";
    dashboardMocks.currentUser.facilityId = 99;

    const response = await requestActivity();

    expect(response.status).toBe(200);
    expect(dashboardMocks.inArray).toHaveBeenCalledWith(
      "auditLogs.userId",
      dashboardMocks.scopedUserIds,
    );
    expect(dashboardMocks.eq).not.toHaveBeenCalled();
    expect(dashboardMocks.and).not.toHaveBeenCalled();
    expect(dashboardMocks.where).toHaveBeenCalledWith({
      kind: "inArray",
      column: "auditLogs.userId",
      values: dashboardMocks.scopedUserIds,
    });
  });
});
