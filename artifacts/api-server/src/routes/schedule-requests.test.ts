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
import type { ScheduleRequestRow, User } from "@workspace/db";

const state = vi.hoisted(() => ({
  role: "employee" as string | null,
  transaction: vi.fn(),
  select: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: { transaction: state.transaction, select: state.select },
  usersTable: {},
  shiftSchedulesTable: {},
  shiftScheduleMembersTable: {},
  scheduleRequestsTable: {},
  notificationsTable: {},
  auditLogsTable: {},
}));
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
vi.mock("../lib/rateLimit", () => ({
  rateLimit: () => (_req: Request, _res: Response, next: NextFunction) =>
    next(),
}));

import router, {
  canReviewScheduleRequest,
  hasConflictingApprovedScheduleRequest,
  scheduleRequestDecisionIssue,
  scheduleRequestDecisionMode,
  scheduleRequestAuditDetails,
  serializeScheduleRequest,
} from "./schedule-requests";

function user(id: number, role: User["role"], patch: Partial<User> = {}): User {
  return {
    id,
    email: `u${id}@example.test`,
    passwordHash: "not-used",
    name: `User ${id}`,
    nameAr: `مستخدم ${id}`,
    role,
    departmentId: 7,
    supervisorId: null,
    facilityId: 1,
    jobTitle: "",
    jobTitleAr: "",
    employeeNumber: `${id}`,
    phone: null,
    phoneVerifiedAt: null,
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
    createdAt: new Date("2030-01-01T00:00:00Z"),
    ...patch,
  };
}

describe("schedule request route boundaries", () => {
  let server: ReturnType<typeof express.application.listen>;
  let origin: string;
  const valid = {
    kind: "leave",
    startDate: "2031-01-02",
    endDate: "2031-01-03",
    note: "Operational context only",
  };
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
    state.role = "employee";
    state.transaction.mockReset();
    state.select.mockReset();
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects unauthenticated access before database work", async () => {
    state.role = null;
    for (const [path, data] of [
      ["/schedule-requests", valid],
      ["/schedule-requests/mine", undefined],
      ["/schedule-requests/review", undefined],
      ["/schedule-requests/1/withdraw", { expectedVersion: 1 }],
      [
        "/schedule-requests/1/decision",
        { expectedVersion: 1, decision: "approved" },
      ],
    ] as const)
      expect((await call(path, data)).status).toBe(401);
    expect(state.transaction).not.toHaveBeenCalled();
  });

  it("employees cannot review or decide requests", async () => {
    expect((await call("/schedule-requests/review")).status).toBe(403);
    expect(
      (
        await call("/schedule-requests/1/decision", {
          expectedVersion: 1,
          decision: "approved",
        })
      ).status,
    ).toBe(403);
    expect(state.transaction).not.toHaveBeenCalled();
    expect(state.select).not.toHaveBeenCalled();
  });

  it.each([
    { ...valid, startDate: "2031-02-30", endDate: "2031-02-30" },
    { ...valid, endDate: "2031-02-01" },
    { ...valid, kind: "off", endDate: "2031-01-03" },
    {
      ...valid,
      kind: "preferred_shift",
      startDate: "2031-01-02",
      endDate: "2031-01-02",
    },
    {
      ...valid,
      kind: "off",
      startDate: "2031-01-02",
      endDate: "2031-01-02",
      shiftCode: "D",
    },
    { ...valid, note: "   " },
    { ...valid, unexpected: "rejected" },
  ])("rejects invalid request input before database work %#", async (body) => {
    expect((await call("/schedule-requests", body)).status).toBe(400);
    expect(state.transaction).not.toHaveBeenCalled();
  });

  it("requires CAS versions and rejects malformed identifiers", async () => {
    expect((await call("/schedule-requests/1/withdraw", {})).status).toBe(428);
    state.role = "supervisor";
    expect(
      (
        await call("/schedule-requests/1/decision", {
          decision: "approved",
        })
      ).status,
    ).toBe(428);
    expect(
      (
        await call("/schedule-requests/1.5/decision", {
          expectedVersion: 1,
          decision: "approved",
        })
      ).status,
    ).toBe(400);
    expect(state.transaction).not.toHaveBeenCalled();
    expect(state.select).not.toHaveBeenCalled();
  });
});

describe("schedule request review hierarchy", () => {
  const employee = user(10, "employee", { supervisorId: 20 });

  it("allows only a direct supervisor and lower-ranked in-tenant targets", () => {
    expect(canReviewScheduleRequest(user(20, "supervisor"), employee, 1)).toBe(
      true,
    );
    expect(canReviewScheduleRequest(user(21, "supervisor"), employee, 1)).toBe(
      false,
    );
    expect(
      canReviewScheduleRequest(
        user(30, "department_manager", { departmentId: 7 }),
        employee,
        1,
      ),
    ).toBe(true);
    expect(
      canReviewScheduleRequest(
        user(31, "department_manager", { departmentId: 8 }),
        employee,
        1,
      ),
    ).toBe(false);
    expect(
      canReviewScheduleRequest(user(40, "hospital_admin"), employee, 1),
    ).toBe(true);
  });

  it("blocks cross-facility, self, inactive, and peer approval", () => {
    expect(
      canReviewScheduleRequest(
        user(40, "hospital_admin", { facilityId: 2 }),
        employee,
        1,
      ),
    ).toBe(false);
    expect(canReviewScheduleRequest(employee, employee, 1)).toBe(false);
    expect(
      canReviewScheduleRequest(
        user(40, "hospital_admin", { isActive: false }),
        employee,
        1,
      ),
    ).toBe(false);
    expect(
      canReviewScheduleRequest(
        user(40, "hospital_admin"),
        user(41, "hospital_admin"),
        1,
      ),
    ).toBe(false);
    expect(
      canReviewScheduleRequest(user(50, "system_admin"), employee, 1),
    ).toBe(true);
  });

  it("keeps audit details free of notes, dates, employee identity, and shift", () => {
    const details = scheduleRequestAuditDetails({
      id: 5,
      status: "approved",
      rowVersion: 2,
      feasibilityStatus: "possible",
      note: "private medical note",
      startDate: "2031-01-01",
      employeeId: 10,
      shiftCode: "D",
    } as never);
    expect(JSON.parse(details)).toEqual({
      requestId: 5,
      status: "approved",
      version: 2,
      feasibilityStatus: "possible",
    });
    expect(details).not.toContain("private medical note");
    expect(details).not.toContain("2031-01-01");
  });

  it("blocks approving a preferred shift over an approved OFF request", () => {
    const approvedOff = {
      id: 70,
      employeeId: 10,
      kind: "off",
      startDate: "2031-01-05",
      endDate: "2031-01-05",
      status: "approved",
    } as const;
    const preferredShift = {
      id: 71,
      employeeId: 10,
      kind: "preferred_shift",
      startDate: "2031-01-05",
      endDate: "2031-01-05",
      shiftCode: "D",
      status: "pending",
    } as const;
    expect(
      hasConflictingApprovedScheduleRequest(preferredShift, [approvedOff]),
    ).toBe(true);
    expect(
      hasConflictingApprovedScheduleRequest(
        { ...preferredShift, startDate: "2031-01-06", endDate: "2031-01-06" },
        [approvedOff],
      ),
    ).toBe(false);
  });

  it("permits only pending decisions and approved-to-rejected revocation", () => {
    expect(scheduleRequestDecisionMode("pending", "approved")).toBe("initial");
    expect(scheduleRequestDecisionMode("pending", "rejected")).toBe("initial");
    expect(scheduleRequestDecisionMode("approved", "rejected")).toBe(
      "revocation",
    );
    expect(scheduleRequestDecisionMode("approved", "approved")).toBeNull();
    expect(scheduleRequestDecisionMode("rejected", "approved")).toBeNull();
    expect(scheduleRequestDecisionMode("rejected", "rejected")).toBeNull();
    expect(scheduleRequestDecisionMode("withdrawn", "approved")).toBeNull();
    expect(
      scheduleRequestDecisionIssue(
        { status: "approved", rowVersion: 4 },
        3,
        "rejected",
      ),
    ).toBe("schedule_request_version_conflict");
    expect(
      scheduleRequestDecisionIssue(
        { status: "approved", rowVersion: 4 },
        4,
        "approved",
      ),
    ).toBe("schedule_request_not_decidable");
    expect(
      scheduleRequestDecisionIssue(
        { status: "approved", rowVersion: 4 },
        4,
        "rejected",
      ),
    ).toBeNull();
  });

  it("hides schedule identifiers and detailed feasibility reasons from employees", () => {
    const row = {
      id: 80,
      employeeId: 10,
      facilityId: 1,
      kind: "leave",
      startDate: "2031-01-05",
      endDate: "2031-01-06",
      shiftCode: null,
      note: null,
      status: "pending",
      rowVersion: 1,
      feasibilityStatus: "conflict",
      feasibilityReasonCodes: ["coverage_shortage"],
      evaluatedScheduleId: 99,
      evaluatedScheduleVersion: 7,
      evaluatedAt: new Date("2030-12-20T00:00:00Z"),
      decidedBy: 40,
      decidedAt: null,
      createdAt: new Date("2030-12-20T00:00:00Z"),
      updatedAt: new Date("2030-12-20T00:00:00Z"),
    } satisfies ScheduleRequestRow;
    const employeeProjection = serializeScheduleRequest(
      row,
      employee,
      "employee",
    );
    expect(employeeProjection.feasibility).toMatchObject({
      status: "conflict",
      reasonCodes: ["generic"],
      scheduleId: null,
      scheduleVersion: null,
    });
    expect(employeeProjection.decidedBy).toBeNull();
    const reviewProjection = serializeScheduleRequest(row, employee, "review");
    expect(reviewProjection.feasibility).toMatchObject({
      reasonCodes: ["coverage_shortage"],
      scheduleId: 99,
      scheduleVersion: 7,
    });
    expect(reviewProjection.decidedBy).toBe(40);
  });
});
