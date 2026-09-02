import { describe, expect, it } from "vitest";
import {
  ApiError,
  type Schedule,
  type ShiftType,
} from "@workspace/api-client-react";
import {
  assignmentSignature,
  canManageSchedules,
  canPublish,
  cellKey,
  coveragePreview,
  currentMonth,
  dateRange,
  employeeName,
  monthDates,
  replaceAssignment,
  rosterCapacity,
  scheduleErrorKey,
  scheduleIssueKey,
  shiftName,
} from "./schedule-state";

const shift: ShiftType = {
  code: "M",
  label: "Morning",
  labelAr: "صباحي",
  startTime: "07:00",
  endTime: "15:00",
  requiredPerDay: 1,
};
const schedule: Schedule = {
  id: 1,
  title: "Test schedule",
  month: "2028-02",
  status: "draft",
  version: 3,
  employeeCount: 1,
  shortageCount: 0,
  createdAt: "2028-01-01T00:00:00Z",
  updatedAt: "2028-01-01T00:00:00Z",
  facilityId: 2,
  employeeIds: [4],
  shiftTypes: [shift],
  constraints: {
    minRestHours: 11,
    maxConsecutiveDays: 5,
    maxShiftsPerMonth: 22,
  },
  unavailability: [],
  assignments: [{ employeeId: 4, date: "2028-02-01", shiftCode: "M" }],
  issues: [],
  shortages: [],
  warnings: ["planning_assistance_only", "boundary_review_required"],
};

describe("schedule presentation and editing state", () => {
  it.each([
    ["2026-08-31T20:59:00.000Z", "2026-08"],
    ["2026-08-31T20:59:59.999Z", "2026-08"],
    ["2026-08-31T21:00:00.000Z", "2026-09"],
    ["2026-12-31T21:00:00.000Z", "2027-01"],
  ])("uses the Riyadh month at UTC instant %s", (instant, month) => {
    expect(currentMonth(new Date(instant))).toBe(month);
  });
  it.each([
    "2026-08-31T21:00:00Z",
    "2026-09-01T00:00:00+03:00",
    "2026-08-31T14:00:00-07:00",
    "2026-09-01T11:00:00+14:00",
  ])(
    "normalizes equivalent ISO offset instants %s to the same API month",
    (instant) => {
      const month = currentMonth(new Date(instant));
      expect(month).toBe("2026-09");
      expect(monthDates(month)[0]).toBe("2026-09-01");
      expect(monthDates(month).at(-1)).toBe("2026-09-30");
    },
  );
  it("keeps ISO calendar dates unchanged during calendar generation", () => {
    expect(currentMonth(new Date("2028-02-29"))).toBe("2028-02");
    expect(monthDates("2028-02").at(-1)).toBe("2028-02-29");
  });
  it("generates calendar-valid dates including leap years", () => {
    expect(monthDates("2028-02")).toHaveLength(29);
    expect(monthDates("2027-02").at(-1)).toBe("2027-02-28");
    expect(monthDates("2027-04")).toHaveLength(30);
  });
  it.each(["2026-13", "2026-00", "1999-12", "2026-1", "bad"])(
    "rejects an invalid API month %s",
    (month) => {
      expect(monthDates(month)).toEqual([]);
    },
  );
  it("expands only inclusive within-month unavailability ranges", () => {
    expect(dateRange("2028-02", "2028-02-27", "2028-02-29")).toEqual([
      "2028-02-27",
      "2028-02-28",
      "2028-02-29",
    ]);
    expect(dateRange("2027-02", "2027-02-28", "2027-02-29")).toEqual([]);
    expect(dateRange("2028-02", "2028-01-31", "2028-02-02")).toEqual([]);
    expect(dateRange("2028-02", "2028-02-02", "2028-02-01")).toEqual([]);
  });
  it("separates off from unavailable and replaces one cell without mutation", () => {
    const original = schedule.assignments;
    const changed = replaceAssignment(original, 4, "2028-02-01", "N");
    expect(changed).toEqual([
      { employeeId: 4, date: "2028-02-01", shiftCode: "N" },
    ]);
    expect(original[0].shiftCode).toBe("M");
    expect(replaceAssignment(changed, 4, "2028-02-01", "")).toEqual([]);
    expect(cellKey(4, "2028-02-01")).not.toBe(cellKey(5, "2028-02-01"));
  });
  it("normalizes assignment order when detecting unsaved work", () => {
    const assignments = [
      ...schedule.assignments,
      { employeeId: 5, date: "2028-02-02", shiftCode: "M" },
    ];
    expect(assignmentSignature(assignments)).toBe(
      assignmentSignature([...assignments].reverse()),
    );
    expect(assignmentSignature(assignments)).not.toBe(
      assignmentSignature(replaceAssignment(assignments, 4, "2028-02-01", "")),
    );
  });
  it("previews each day and shift's unfilled coverage", () => {
    const coverage = coveragePreview("2028-02", [shift], schedule.assignments);
    expect(coverage).toHaveLength(29);
    expect(coverage[0]).toEqual({
      date: "2028-02-01",
      shiftCode: "M",
      required: 1,
      assigned: 1,
    });
    expect(coverage[1].assigned).toBe(0);
  });
  it("blocks publication of dirty, conflicting, pending, incomplete or nondraft schedules", () => {
    expect(canPublish(schedule, schedule.assignments, false, false)).toBe(true);
    expect(canPublish(schedule, [], false, false)).toBe(false);
    expect(canPublish(schedule, schedule.assignments, true, false)).toBe(false);
    expect(canPublish(schedule, schedule.assignments, false, true)).toBe(false);
    expect(
      canPublish(
        { ...schedule, status: "published" },
        schedule.assignments,
        false,
        false,
      ),
    ).toBe(false);
    expect(
      canPublish(
        { ...schedule, status: "cancelled" },
        schedule.assignments,
        false,
        false,
      ),
    ).toBe(false);
    expect(
      canPublish(
        {
          ...schedule,
          shortages: [
            { date: "2028-02-01", shiftCode: "M", required: 2, assigned: 1 },
          ],
        },
        schedule.assignments,
        false,
        false,
      ),
    ).toBe(false);
    expect(
      canPublish(
        { ...schedule, issues: ["monthly_shift_limit"] },
        schedule.assignments,
        false,
        false,
      ),
    ).toBe(false);
  });
  it("calculates the monthly staffing lower bound from coverage and limits", () => {
    expect(
      rosterCapacity({
        ...schedule,
        month: "2026-09",
        employeeIds: [1, 2, 3],
        shiftTypes: [
          { ...shift, code: "M" },
          { ...shift, code: "A" },
          { ...shift, code: "N" },
        ],
      }),
    ).toEqual({ required: 90, available: 66, minimumEmployees: 5 });
  });
  it("maps stored planning issue codes without exposing unknown server text", () => {
    expect(scheduleIssueKey("monthly_shift_limit")).toBe(
      "issue_monthly_shift_limit",
    );
    expect(scheduleIssueKey("approved_request_conflict")).toBe(
      "issue_request_conflict",
    );
    expect(scheduleIssueKey("private_internal_detail")).toBe("invalid");
  });
  it("keeps all recognized management roles and fails closed for unknown roles", () => {
    for (const role of [
      "supervisor",
      "department_manager",
      "hospital_admin",
      "system_admin",
    ])
      expect(canManageSchedules(role)).toBe(true);
    for (const role of [undefined, "employee", "admin", ""])
      expect(canManageSchedules(role)).toBe(false);
  });
  it("localizes names with a safe bilingual fallback", () => {
    expect(employeeName({ name: "Example", nameAr: "مثال" }, true)).toBe(
      "مثال",
    );
    expect(employeeName({ name: "Example", nameAr: "" }, true)).toBe("Example");
    expect(shiftName(shift, true)).toBe("صباحي");
    expect(shiftName(shift, false)).toBe("Morning");
  });
  it.each([
    [409, "schedule_version_conflict", "conflict"],
    [409, "invalid_schedule_status", "conflict"],
    [409, "employee_month_already_scheduled", "overlap"],
    [409, "coverage_shortage", "issue_coverage"],
    [400, "insufficient_rest", "issue_minimum_rest"],
    [400, "monthly_shift_limit", "issue_monthly_shift_limit"],
    [409, "approved_request_conflict", "issue_request_conflict"],
    [403, "forbidden", "forbidden"],
    [404, "schedule_not_found", "forbidden"],
    [500, "failed", "failed"],
  ] as const)(
    "maps %s/%s without leaking server text",
    (status, code, expected) => {
      const error = new ApiError(
        new Response(null, { status }),
        { code, message: "Do not render raw private context" },
        { method: "PATCH", url: "/api/schedules/1" },
      );
      expect(scheduleErrorKey(error)).toBe(expected);
    },
  );
});
