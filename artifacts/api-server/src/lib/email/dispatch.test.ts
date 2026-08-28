import type { User } from "@workspace/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  insertResult: [{ id: 901 }] as Array<{ id: number }>,
  computeEmployeeStats: vi.fn(),
  getCredentialsFor: vi.fn(),
  getPolicies: vi.fn(),
  isEmailConfigured: vi.fn(() => false),
  sendEmail: vi.fn(async () => undefined),
  weeklyDigestEmail: vi.fn(() => "<p>scoped digest</p>"),
}));

function queryReturning(result: unknown[]) {
  const terminal = Promise.resolve(result);
  const query = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    then: terminal.then.bind(terminal),
  };
  query.from.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  return query;
}

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => conditions),
  desc: vi.fn((column: unknown) => ({ column, direction: "desc" })),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  inArray: vi.fn((column: unknown, values: unknown[]) => ({ column, values })),
  isNull: vi.fn((column: unknown) => ({ column, isNull: true })),
  notExists: vi.fn((query: unknown) => ({ query, notExists: true })),
  sql: vi.fn(() => ({ kind: "sql" })),
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => queryReturning(state.selectResults.shift() ?? [])),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => state.insertResult),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
  },
  usersTable: {
    id: "users.id",
    role: "users.role",
    isActive: "users.isActive",
    facilityId: "users.facilityId",
    departmentId: "users.departmentId",
    supervisorId: "users.supervisorId",
  },
  notificationsTable: { id: "notifications.id", type: "notifications.type" },
  credentialsTable: {
    id: "credentials.id",
    deletedAt: "credentials.deletedAt",
  },
  emailLogTable: {
    id: "emailLog.id",
    userId: "emailLog.userId",
    kind: "emailLog.kind",
    status: "emailLog.status",
    createdAt: "emailLog.createdAt",
    notificationId: "emailLog.notificationId",
  },
}));

vi.mock("../helpers", () => ({
  computeEmployeeStats: state.computeEmployeeStats,
  getCredentialsFor: state.getCredentialsFor,
  getPolicies: state.getPolicies,
}));

vi.mock("./sender", () => ({
  EmailNotConfiguredError: class EmailNotConfiguredError extends Error {},
  createEmailIdempotencyKey: vi.fn(() => "weekly-digest:901"),
  isEmailConfigured: state.isEmailConfigured,
  isFixtureRecipient: vi.fn(() => false),
  sendEmail: state.sendEmail,
}));

vi.mock("./templates", () => ({
  expiryAlertEmail: vi.fn(),
  weeklyDigestEmail: state.weeklyDigestEmail,
}));

vi.mock("../logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { filterWeeklyDigestMembers, sendWeeklyDigests } from "./dispatch";

function user(overrides: Partial<User>): User {
  return {
    id: 1,
    email: "user@example.sa",
    passwordHash: "hash",
    name: "User",
    nameAr: "مستخدم",
    role: "employee",
    departmentId: 7,
    supervisorId: null,
    facilityId: 10,
    jobTitle: "Role",
    jobTitleAr: "دور",
    employeeNumber: "EMP-1",
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
    notificationPrefs: [90, 60, 30, 15, 7, 1],
    createdAt: new Date("2026-08-29T00:00:00.000Z"),
    ...overrides,
  };
}

describe("weekly digest role and facility scope", () => {
  beforeEach(() => {
    state.selectResults = [];
    state.insertResult = [{ id: 901 }];
    state.computeEmployeeStats.mockReset();
    state.getCredentialsFor.mockReset();
    state.getPolicies.mockReset();
    state.isEmailConfigured.mockReset();
    state.isEmailConfigured.mockReturnValue(false);
    state.sendEmail.mockReset();
    state.sendEmail.mockResolvedValue(undefined);
    state.weeklyDigestEmail.mockReset();
    state.weeklyDigestEmail.mockReturnValue("<p>scoped digest</p>");
  });

  it("keeps a supervisor to active lower-ranked direct reports in one facility", () => {
    const manager = user({ id: 10, role: "supervisor" });
    const candidates = [
      user({ id: 11, supervisorId: 10 }),
      user({ id: 12, role: "supervisor", supervisorId: 10 }),
      user({ id: 13, role: "department_manager", supervisorId: 10 }),
      user({ id: 14, supervisorId: 10, facilityId: 20 }),
      user({ id: 15, supervisorId: 99 }),
      user({ id: 16, supervisorId: 10, isActive: false }),
      user({ id: 10, role: "supervisor", supervisorId: 10 }),
    ];

    expect(
      filterWeeklyDigestMembers(manager, candidates).map(({ id }) => id),
    ).toEqual([11]);
  });

  it("keeps a department manager to active lower-ranked members of one department", () => {
    const manager = user({ id: 20, role: "department_manager" });
    const candidates = [
      user({ id: 21 }),
      user({ id: 22, role: "supervisor" }),
      user({ id: 23, role: "department_manager" }),
      user({ id: 24, role: "hospital_admin" }),
      user({ id: 25, role: "system_admin" }),
      user({ id: 26, departmentId: 8 }),
      user({ id: 27, facilityId: 20 }),
      user({ id: 28, isActive: false }),
      user({ id: 20, role: "department_manager" }),
    ];

    expect(
      filterWeeklyDigestMembers(manager, candidates).map(({ id }) => id),
    ).toEqual([21, 22]);
  });

  it.each(["employee", "hospital_admin", "system_admin"] as const)(
    "rejects the unsupported %s digest-manager role",
    (role) => {
      const manager = user({ id: 30, role });
      expect(filterWeeklyDigestMembers(manager, [user({ id: 31 })])).toEqual(
        [],
      );
    },
  );

  it("never passes out-of-scope digest candidates to credential lookup, templates, or delivery", async () => {
    const manager = user({
      id: 20,
      email: "manager@example.sa",
      name: "Manager",
      nameAr: "مدير",
      role: "department_manager",
      departmentId: 7,
      facilityId: 10,
    });
    const allowedEmployee = user({ id: 21, name: "Allowed Employee" });
    const allowedSupervisor = user({
      id: 22,
      name: "Allowed Supervisor",
      role: "supervisor",
    });
    const candidates = [
      allowedEmployee,
      allowedSupervisor,
      user({ id: 23, name: "Peer Manager", role: "department_manager" }),
      user({ id: 24, name: "Other Department", departmentId: 8 }),
      user({ id: 25, name: "Other Facility", facilityId: 99 }),
      user({ id: 26, name: "Inactive Employee", isActive: false }),
    ];

    // Managers, most-recent digest ledger row, then the department candidates.
    state.selectResults = [[manager], [], candidates];
    state.isEmailConfigured.mockReturnValue(true);
    state.getPolicies.mockResolvedValue([]);
    state.getCredentialsFor.mockResolvedValue([]);
    state.computeEmployeeStats.mockReturnValue({
      expiredCount: 1,
      expiringCount: 0,
      missingCount: 0,
    });

    await sendWeeklyDigests();

    expect(state.getCredentialsFor).toHaveBeenCalledOnce();
    expect(state.getCredentialsFor).toHaveBeenCalledWith([21, 22]);
    expect(
      state.computeEmployeeStats.mock.calls.map(([member]) => member.id),
    ).toEqual([21, 22]);
    expect(state.weeklyDigestEmail).toHaveBeenCalledOnce();
    expect(state.weeklyDigestEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        members: [
          expect.objectContaining({ name: "Allowed Employee" }),
          expect.objectContaining({ name: "Allowed Supervisor" }),
        ],
      }),
    );
    expect(state.sendEmail).toHaveBeenCalledOnce();
    expect(state.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "manager@example.sa",
        html: "<p>scoped digest</p>",
      }),
    );
  });
});
