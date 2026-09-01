import { describe, expect, it } from "vitest";
import type { ShiftScheduleRow } from "@workspace/db";
import {
  assignmentConflictsWithApprovedRequest,
  evaluateScheduleRequestFeasibility,
  type ScheduleRequestEvaluationInput,
} from "./scheduleRequestFeasibility";

function row(assignments: ShiftScheduleRow["assignments"]): ShiftScheduleRow {
  return {
    id: 10,
    facilityId: 1,
    title: "January roster",
    month: "2031-01",
    status: "draft",
    rowVersion: 3,
    configuration: {
      employeeIds: [1, 2],
      shiftTypes: [
        {
          code: "D",
          label: "Day",
          labelAr: "نهار",
          startTime: "08:00",
          endTime: "16:00",
          requiredPerDay: 1,
        },
        {
          code: "N",
          label: "Night",
          labelAr: "ليل",
          startTime: "20:00",
          endTime: "04:00",
          requiredPerDay: 0,
        },
      ],
      constraints: {
        minRestHours: 8,
        maxConsecutiveDays: 6,
        maxShiftsPerMonth: 20,
      },
      unavailability: [],
    },
    assignments,
    createdBy: 8,
    updatedBy: 8,
    createdAt: new Date("2030-12-01T00:00:00Z"),
    updatedAt: new Date("2030-12-02T00:00:00Z"),
  };
}

function request(
  patch: Partial<ScheduleRequestEvaluationInput> = {},
): ScheduleRequestEvaluationInput {
  return {
    employeeId: 1,
    kind: "off",
    startDate: "2031-01-02",
    endDate: "2031-01-02",
    shiftCode: null,
    ...patch,
  };
}

describe("schedule request feasibility", () => {
  it("returns unknown when no current roster exists", () => {
    expect(evaluateScheduleRequestFeasibility(request(), null)).toEqual({
      status: "unknown",
      reasonCodes: ["schedule_not_found"],
    });
  });

  it("detects a coverage conflict when non-working time removes staffing", () => {
    const schedule = row([
      { employeeId: 1, date: "2031-01-02", shiftCode: "D" },
    ]);
    expect(evaluateScheduleRequestFeasibility(request(), schedule)).toEqual({
      status: "conflict",
      reasonCodes: ["coverage_shortage"],
    });
  });

  it("does not mistake an unrelated existing shortage for a new conflict", () => {
    const schedule = row([
      { employeeId: 1, date: "2031-01-03", shiftCode: "D" },
    ]);
    expect(evaluateScheduleRequestFeasibility(request(), schedule)).toEqual({
      status: "possible",
      reasonCodes: ["already_unassigned"],
    });
  });

  it("validates a preferred shift replacement through schedule constraints", () => {
    const schedule = row([
      { employeeId: 1, date: "2031-01-02", shiftCode: "D" },
      { employeeId: 2, date: "2031-01-02", shiftCode: "N" },
    ]);
    expect(
      evaluateScheduleRequestFeasibility(
        request({ kind: "preferred_shift", shiftCode: "N" }),
        schedule,
      ),
    ).toEqual({ status: "conflict", reasonCodes: ["coverage_shortage"] });
    expect(
      evaluateScheduleRequestFeasibility(
        request({ kind: "preferred_shift", shiftCode: "D" }),
        schedule,
      ),
    ).toEqual({
      status: "possible",
      reasonCodes: ["preferred_shift_unchanged"],
    });
  });

  it("rejects an unknown requested shift without mutating a roster", () => {
    expect(
      evaluateScheduleRequestFeasibility(
        request({ kind: "preferred_shift", shiftCode: "X" }),
        row([]),
      ),
    ).toEqual({ status: "conflict", reasonCodes: ["shift_not_configured"] });
  });

  it("flags that a published reference roster must be reopened before editing", () => {
    const published = { ...row([]), status: "published" } as ShiftScheduleRow;
    expect(evaluateScheduleRequestFeasibility(request(), published)).toEqual({
      status: "possible",
      reasonCodes: ["already_unassigned", "published_schedule_requires_reopen"],
    });
  });
});

describe("approved request publication guard", () => {
  const assignments = [{ employeeId: 1, date: "2031-01-02", shiftCode: "D" }];

  it("blocks working during approved leave, off, or EO", () => {
    for (const kind of ["leave", "off", "eo"] as const)
      expect(
        assignmentConflictsWithApprovedRequest(request({ kind }), assignments),
      ).toBe(true);
  });

  it("requires the approved preferred shift on that day", () => {
    expect(
      assignmentConflictsWithApprovedRequest(
        request({ kind: "preferred_shift", shiftCode: "D" }),
        assignments,
      ),
    ).toBe(false);
    expect(
      assignmentConflictsWithApprovedRequest(
        request({ kind: "preferred_shift", shiftCode: "N" }),
        assignments,
      ),
    ).toBe(true);
  });
});
