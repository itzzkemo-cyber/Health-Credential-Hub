import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auditMocks = vi.hoisted(() => ({
  currentUser: {
    id: 3,
    role: "hospital_admin",
    facilityId: 20,
  },
  eq: vi.fn(),
  where: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  desc: vi.fn((column: unknown) => ({ descending: column })),
  eq: auditMocks.eq,
}));

vi.mock("@workspace/db", () => {
  const auditLogsTable = {
    facilityId: "auditLogs.facilityId",
    createdAt: "auditLogs.createdAt",
  };
  return {
    auditLogsTable,
    db: {
      select: vi.fn(() => {
        const query = {
          from: vi.fn(() => query),
          where: auditMocks.where,
          orderBy: vi.fn(() => query),
          limit: vi.fn(async () => []),
        };
        auditMocks.where.mockReturnValue(query);
        return query;
      }),
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

describe("audit log tenant query", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  beforeEach(() => {
    auditMocks.eq.mockReset();
    auditMocks.where.mockClear();
    auditMocks.eq.mockImplementation((left, right) => ({ left, right }));
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
  });

  it("filters hospital administrators by the audit event facility", async () => {
    const app = express();
    app.use("/api", router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a disposable TCP listener");
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/audit-logs`,
    );

    expect(response.status).toBe(200);
    expect(auditMocks.eq).toHaveBeenCalledWith(
      "auditLogs.facilityId",
      auditMocks.currentUser.facilityId,
    );
    expect(auditMocks.where).toHaveBeenCalledWith({
      left: "auditLogs.facilityId",
      right: auditMocks.currentUser.facilityId,
    });
  });
});
