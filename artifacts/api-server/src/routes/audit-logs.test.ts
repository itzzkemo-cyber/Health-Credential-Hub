import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auditMocks = vi.hoisted(() => ({
  currentUser: {
    id: 3,
    role: "hospital_admin",
    facilityId: 20,
  },
  select: vi.fn(),
  countWhere: vi.fn(),
  rowsWhere: vi.fn(),
  limit: vi.fn(),
  offset: vi.fn(),
  eq: vi.fn(),
  ilike: vi.fn(),
  gte: vi.fn(),
  lt: vi.fn(),
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...clauses: unknown[]) => ({ op: "and", clauses })),
  count: vi.fn(() => "count(*)"),
  desc: vi.fn((column: unknown) => ({ descending: column })),
  eq: auditMocks.eq,
  gte: auditMocks.gte,
  ilike: auditMocks.ilike,
  lt: auditMocks.lt,
  or: vi.fn((...clauses: unknown[]) => ({ op: "or", clauses })),
}));

vi.mock("@workspace/db", () => {
  const auditLogsTable = {
    action: "auditLogs.action",
    actionAr: "auditLogs.actionAr",
    createdAt: "auditLogs.createdAt",
    facilityId: "auditLogs.facilityId",
    userId: "auditLogs.userId",
  };
  return {
    auditLogsTable,
    db: {
      select: auditMocks.select,
    },
  };
});

vi.mock("../lib/auth", () => ({
  ADMIN_ROLES: ["system_admin", "hospital_admin"],
  getUser: vi.fn(() => auditMocks.currentUser),
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

import router from "./audit-logs";

const rowsQuery = {
  from: vi.fn(),
  where: auditMocks.rowsWhere,
  orderBy: vi.fn(),
  limit: auditMocks.limit,
  offset: auditMocks.offset,
};
rowsQuery.from.mockImplementation(() => rowsQuery);
rowsQuery.orderBy.mockImplementation(() => rowsQuery);

describe("audit log tenant query", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  beforeEach(() => {
    auditMocks.currentUser.role = "hospital_admin";
    auditMocks.select.mockReset();
    auditMocks.countWhere.mockReset();
    auditMocks.rowsWhere.mockReset();
    auditMocks.limit.mockReset();
    auditMocks.offset.mockReset();
    auditMocks.eq.mockReset();
    auditMocks.ilike.mockReset();
    auditMocks.gte.mockReset();
    auditMocks.lt.mockReset();
    rowsQuery.from.mockClear();
    rowsQuery.orderBy.mockClear();
    auditMocks.rows = [];
    auditMocks.eq.mockImplementation((left, right) => ({
      op: "eq",
      left,
      right,
    }));
    auditMocks.ilike.mockImplementation((left, right) => ({
      op: "ilike",
      left,
      right,
    }));
    auditMocks.gte.mockImplementation((left, right) => ({
      op: "gte",
      left,
      right,
    }));
    auditMocks.lt.mockImplementation((left, right) => ({
      op: "lt",
      left,
      right,
    }));

    auditMocks.countWhere.mockResolvedValue([{ total: 0 }]);
    auditMocks.rowsWhere.mockImplementation(() => rowsQuery);
    auditMocks.limit.mockImplementation(() => rowsQuery);
    auditMocks.offset.mockImplementation(async () => auditMocks.rows);
    auditMocks.select.mockImplementation((selection?: unknown) => {
      if (selection) {
        return {
          from: vi.fn(() => ({ where: auditMocks.countWhere })),
        };
      }
      return rowsQuery;
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
  });

  async function request(query = ""): Promise<Response> {
    const app = express();
    app.use("/api", router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a disposable TCP listener");
    }
    return fetch(
      `http://127.0.0.1:${address.port}/api/audit-logs${query}`,
    );
  }

  it("filters hospital administrators inside SQL before counting", async () => {
    const response = await request();

    expect(response.status).toBe(200);
    expect(auditMocks.eq).toHaveBeenCalledWith(
      "auditLogs.facilityId",
      auditMocks.currentUser.facilityId,
    );
    const where = {
      op: "and",
      clauses: [
        {
          op: "eq",
          left: "auditLogs.facilityId",
          right: auditMocks.currentUser.facilityId,
        },
      ],
    };
    expect(auditMocks.countWhere).toHaveBeenCalledWith(where);
    expect(auditMocks.rowsWhere).toHaveBeenCalledWith(where);
    expect(auditMocks.limit).toHaveBeenCalledWith(50);
    expect(auditMocks.offset).toHaveBeenCalledWith(0);
  });

  it("applies filters and pagination in the database query", async () => {
    const response = await request(
      "?userId=8&action=Verified&page=2&pageSize=25&dateFrom=2026-01-01&dateTo=2026-01-31",
    );

    expect(response.status).toBe(200);
    expect(auditMocks.eq).toHaveBeenCalledWith("auditLogs.userId", 8);
    expect(auditMocks.ilike).toHaveBeenCalledWith(
      "auditLogs.action",
      "%Verified%",
    );
    expect(auditMocks.gte).toHaveBeenCalledOnce();
    expect(auditMocks.lt).toHaveBeenCalledOnce();
    expect(auditMocks.limit).toHaveBeenCalledWith(25);
    expect(auditMocks.offset).toHaveBeenCalledWith(25);
  });

  it("rejects invalid pagination before querying audit data", async () => {
    const response = await request("?page=0&pageSize=500");

    expect(response.status).toBe(400);
    expect(auditMocks.select).not.toHaveBeenCalled();
  });
});
