import express, {
  type NextFunction,
  type Request,
  type Response as ExpressResponse,
} from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  actor: {
    id: 7,
    role: "employee",
    facilityId: 10,
    isActive: true,
  },
  facilities: [
    { id: 10, name: "Facility A", nameAr: "المنشأة أ" },
    { id: 20, name: "Facility B", nameAr: "المنشأة ب" },
  ],
  whereCondition: null as { column: unknown; value: unknown } | null,
  select: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
}));

vi.mock("@workspace/db", () => {
  const facilitiesTable = {
    id: "facilities.id",
    name: "facilities.name",
    nameAr: "facilities.nameAr",
  };
  const db = {
    select: state.select,
  };
  return { db, facilitiesTable };
});

vi.mock("../lib/auth", () => ({
  getUser: vi.fn(() => state.actor),
  requireAuth: (req: Request, res: ExpressResponse, next: NextFunction) => {
    if (req.headers.authorization !== "Bearer valid-session") {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    next();
  },
}));

import router from "./facilities";

describe("facility directory scope", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  beforeEach(() => {
    state.actor.role = "employee";
    state.actor.facilityId = 10;
    state.whereCondition = null;
    state.select.mockReset();
    state.select.mockImplementation(() => {
      const query = {
        from: vi.fn(() => query),
        where: vi.fn((condition: { column: unknown; value: unknown }) => {
          state.whereCondition = condition;
          return query;
        }),
        orderBy: vi.fn(async () =>
          state.whereCondition
            ? state.facilities.filter(
                (facility) => facility.id === state.whereCondition?.value,
              )
            : state.facilities,
        ),
      };
      return query;
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

  async function getFacilities(
    authenticated: boolean,
  ): Promise<globalThis.Response> {
    const app = express();
    app.use("/api", router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a disposable TCP listener");
    }
    return fetch(`http://127.0.0.1:${address.port}/api/facilities`, {
      headers: authenticated
        ? { Authorization: "Bearer valid-session" }
        : undefined,
    });
  }

  it("rejects callers without an authenticated session", async () => {
    const response = await getFacilities(false);

    expect(response.status).toBe(401);
    expect(state.select).not.toHaveBeenCalled();
  });

  it("returns only the caller's facility for non-global roles", async () => {
    const response = await getFacilities(true);

    expect(response.status).toBe(200);
    expect(state.whereCondition).toEqual({
      column: "facilities.id",
      value: 10,
    });
    expect(await response.json()).toEqual([state.facilities[0]]);
  });

  it("allows only system administrators to list every facility", async () => {
    state.actor.role = "system_admin";

    const response = await getFacilities(true);

    expect(response.status).toBe(200);
    expect(state.whereCondition).toBeNull();
    expect(await response.json()).toEqual(state.facilities);
  });
});
