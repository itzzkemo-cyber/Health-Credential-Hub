import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const state = vi.hoisted(() => ({
  role: "supervisor" as string | null,
  transaction: vi.fn(),
}));
vi.mock("@workspace/db", () => ({
  db: { transaction: state.transaction },
  usersTable: {},
  shiftSchedulesTable: {},
  shiftScheduleMembersTable: {},
  auditLogsTable: {},
}));
vi.mock("../lib/helpers", () => ({ getScopedUsers: vi.fn() }));
vi.mock("../lib/auth", () => ({
  MANAGER_ROLES: [
    "supervisor",
    "department_manager",
    "hospital_admin",
    "system_admin",
  ],
  getUser: () => ({ id: 1, role: state.role }),
  requireAuth: (_req: Request, res: Response, next: NextFunction) =>
    state.role ? next() : res.status(401).json({ message: "Unauthorized" }),
  requireRole:
    (...roles: string[]) =>
    (_req: Request, res: Response, next: NextFunction) =>
      state.role && roles.includes(state.role)
        ? next()
        : res.status(403).json({ message: "Forbidden" }),
}));
import router, {
  serializePublishedPersonalSchedule,
  serializePublishedTeamSchedule,
} from "./schedules";

describe("schedule route authorization and strict input boundaries", () => {
  let server: ReturnType<typeof express.application.listen>;
  let origin: string;
  const body = () => ({
    title: "Bounded fixture",
    month: "2031-01",
    employeeIds: [1],
    shiftTypes: [
      {
        code: "D",
        label: "Day",
        labelAr: "نهار",
        startTime: "08:00",
        endTime: "16:00",
        requiredPerDay: 1,
      },
    ],
    constraints: {
      minRestHours: 8,
      maxConsecutiveDays: 6,
      maxShiftsPerMonth: 20,
    },
    unavailability: [],
  });
  const call = (path: string, data?: unknown, method = data ? "POST" : "GET") =>
    fetch(origin + path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  beforeAll(async () => {
    const app = express();
    app.use(express.json(), router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  beforeEach(() => {
    state.role = "supervisor";
    state.transaction.mockClear();
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it("rejects unauthenticated access before database work", async () => {
    state.role = null;
    expect((await call("/schedules?month=2031-01")).status).toBe(401);
    expect((await call("/schedules/mine?month=2031-01")).status).toBe(401);
    expect((await call("/schedules/team?month=2031-01")).status).toBe(401);
    expect(state.transaction).not.toHaveBeenCalled();
  });
  it("employees cannot read full rosters or mutate them", async () => {
    state.role = "employee";
    for (const [path, data, method] of [
      ["/schedules", undefined, "GET"],
      ["/schedules/1", undefined, "GET"],
      ["/schedules", body(), "POST"],
      ["/schedules/1", { expectedVersion: 1, assignments: [] }, "PATCH"],
      ["/schedules/1/publish", { expectedVersion: 1 }, "POST"],
      ["/schedules/1/reopen", { expectedVersion: 1 }, "POST"],
      ["/schedules/1/cancel", { expectedVersion: 1 }, "POST"],
    ] as const)
      expect((await call(path, data, method)).status).toBe(403);
    expect(state.transaction).not.toHaveBeenCalled();
  });
  it.each([
    { ...body(), employeeIds: [1, 1] },
    { ...body(), employeeIds: Array.from({ length: 201 }, (_, i) => i + 1) },
    { ...body(), employeeIds: [2_147_483_648] },
    { ...body(), month: "2031-13" },
    { ...body(), month: "2100-01" },
    { ...body(), unexpected: "rejected" },
    { ...body(), constraints: { ...body().constraints, minRestHours: 1.5 } },
    {
      ...body(),
      constraints: { ...body().constraints, maxConsecutiveDays: 32 },
    },
    {
      ...body(),
      unavailability: [
        {
          employeeId: 1,
          date: "2031-01-01",
          reason: "sensitive reason not accepted",
        },
      ],
    },
    { ...body(), unavailability: [{ employeeId: 1, date: "2031-02-30" }] },
    { ...body(), shiftTypes: [{ ...body().shiftTypes[0], endTime: "08:00" }] },
    { ...body(), shiftTypes: [{ ...body().shiftTypes[0], code: "day" }] },
  ])("rejects malformed or excessive planning input %#", async (data) => {
    expect((await call("/schedules", data)).status).toBe(400);
    expect(state.transaction).not.toHaveBeenCalled();
  });
  it("requires a version for every draft/state mutation", async () => {
    for (const [path, method] of [
      ["/schedules/1", "PATCH"],
      ["/schedules/1/publish", "POST"],
      ["/schedules/1/reopen", "POST"],
      ["/schedules/1/cancel", "POST"],
    ]) {
      expect((await call(path, {}, method)).status).toBe(428);
    }
    expect(state.transaction).not.toHaveBeenCalled();
  });
  it("rejects malformed identifiers and required own-view month", async () => {
    expect((await call("/schedules/1.5")).status).toBe(400);
    expect((await call("/schedules/mine")).status).toBe(400);
    expect((await call("/schedules/team")).status).toBe(400);
    expect((await call("/schedules?month=2031-01&month=2031-02")).status).toBe(
      400,
    );
    expect(state.transaction).not.toHaveBeenCalled();
  });
});

describe("published team roster serialization", () => {
  const row = {
    id: 7,
    title: "Published roster",
    month: "2031-01",
    facilityId: 1,
    status: "published",
    rowVersion: 4,
    configuration: {
      employeeIds: [10, 11],
      shiftTypes: [
        {
          code: "D",
          label: "Day",
          labelAr: "نهار",
          startTime: "08:00",
          endTime: "16:00",
          requiredPerDay: 1,
        },
      ],
      constraints: {
        minRestHours: 8,
        maxConsecutiveDays: 6,
        maxShiftsPerMonth: 20,
      },
      unavailability: [{ employeeId: 10, date: "2031-01-02" }],
    },
    assignments: [
      {
        employeeId: 10,
        date: "2031-01-01",
        shiftCode: "D",
        privateStoredValue: "must never leave the API",
      },
      { employeeId: 11, date: "2031-01-02", shiftCode: "D" },
    ],
    createdBy: 1,
    updatedBy: 1,
    createdAt: new Date("2030-12-01T00:00:00.000Z"),
    updatedAt: new Date("2030-12-02T00:00:00.000Z"),
  } as Parameters<typeof serializePublishedTeamSchedule>[0];
  const participants = [
    { employeeId: 10, name: "Employee 10", nameAr: "موظف 10" },
    { employeeId: 11, name: "Employee 11", nameAr: "موظف 11" },
  ];

  it("returns all teammate assignments and display names without private planning fields", () => {
    const result = serializePublishedTeamSchedule(row, participants);
    expect(result).toMatchObject({
      scheduleId: 7,
      participants,
      assignments: [
        { employeeId: 10, date: "2031-01-01", shiftCode: "D" },
        { employeeId: 11, date: "2031-01-02", shiftCode: "D" },
      ],
    });
    expect(result).not.toHaveProperty("facilityId");
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("version");
    expect(result).not.toHaveProperty("constraints");
    expect(result).not.toHaveProperty("unavailability");
    expect(result).not.toHaveProperty("shortages");
    expect(result?.shiftTypes[0]).not.toHaveProperty("requiredPerDay");
    expect(result?.assignments[0]).not.toHaveProperty("privateStoredValue");
  });

  it("projects the personal view without staffing targets or extra stored assignment fields", () => {
    const result = serializePublishedPersonalSchedule(row, 10);
    expect(result?.assignments).toEqual([
      { employeeId: 10, date: "2031-01-01", shiftCode: "D" },
    ]);
    expect(result?.assignments[0]).not.toHaveProperty("privateStoredValue");
    expect(result?.shiftTypes[0]).not.toHaveProperty("requiredPerDay");
    expect(result).not.toHaveProperty("participants");
  });

  it("fails closed for drafts, missing scoped teammates, and unknown assignment owners", () => {
    expect(
      serializePublishedTeamSchedule({ ...row, status: "draft" }, participants),
    ).toBeNull();
    expect(
      serializePublishedTeamSchedule(row, participants.slice(0, 1)),
    ).toBeNull();
    expect(
      serializePublishedTeamSchedule(
        {
          ...row,
          assignments: [
            ...row.assignments,
            { employeeId: 99, date: "2031-01-03", shiftCode: "D" },
          ],
        },
        participants,
      ),
    ).toBeNull();
  });
});
