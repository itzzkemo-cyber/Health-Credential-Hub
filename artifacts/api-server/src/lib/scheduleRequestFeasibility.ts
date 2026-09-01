import type { ScheduleRequestKind, ShiftScheduleRow } from "@workspace/db";
import {
  validateSchedule,
  type AdjacentAssignment,
  type SchedulePlanningInput,
  type ShiftAssignment,
} from "./shiftScheduling";

export interface ScheduleRequestEvaluationInput {
  employeeId: number;
  kind: ScheduleRequestKind;
  startDate: string;
  endDate: string;
  shiftCode: string | null;
}

export interface ScheduleRequestFeasibilityResult {
  status: "possible" | "conflict" | "unknown";
  reasonCodes: string[];
}

function planningInput(row: ShiftScheduleRow): SchedulePlanningInput {
  return { ...row.configuration, title: row.title, month: row.month };
}

function datesBetween(start: string, end: string): Set<string> {
  const dates = new Set<string>();
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  for (let value = startTime; value <= endTime; value += 86_400_000)
    dates.add(new Date(value).toISOString().slice(0, 10));
  return dates;
}

function shortageAmounts(
  shortages: ReturnType<typeof validateSchedule>["shortages"],
) {
  return new Map(
    shortages.map((item) => [
      `${item.date}:${item.shiftCode}`,
      item.required - item.assigned,
    ]),
  );
}

function worsensCoverage(
  baseline: ReturnType<typeof validateSchedule>["shortages"],
  simulated: ReturnType<typeof validateSchedule>["shortages"],
): boolean {
  const before = shortageAmounts(baseline);
  return simulated.some(
    (item) =>
      item.required - item.assigned >
      (before.get(`${item.date}:${item.shiftCode}`) ?? 0),
  );
}

/**
 * Advisory, deterministic feasibility only. It does not approve a request and
 * makes no legal, clinical, or minimum-staffing-compliance determination.
 */
export function evaluateScheduleRequestFeasibility(
  request: ScheduleRequestEvaluationInput,
  schedule: ShiftScheduleRow | null,
  adjacent: AdjacentAssignment[] = [],
): ScheduleRequestFeasibilityResult {
  if (!schedule || schedule.status === "cancelled")
    return { status: "unknown", reasonCodes: ["schedule_not_found"] };
  if (!schedule.configuration.employeeIds.includes(request.employeeId))
    return { status: "unknown", reasonCodes: ["employee_not_in_schedule"] };

  const input = planningInput(schedule);
  const result = (
    status: ScheduleRequestFeasibilityResult["status"],
    reasonCodes: string[],
  ): ScheduleRequestFeasibilityResult => ({
    status,
    reasonCodes: [
      ...reasonCodes,
      ...(schedule.status === "published"
        ? ["published_schedule_requires_reopen"]
        : []),
    ].slice(0, 20),
  });
  const baseline = validateSchedule(input, schedule.assignments, adjacent);
  let assignments: ShiftAssignment[];

  if (request.kind === "preferred_shift") {
    const shiftCode = request.shiftCode;
    if (
      !shiftCode ||
      !schedule.configuration.shiftTypes.some(
        (shift) => shift.code === shiftCode,
      )
    )
      return result("conflict", ["shift_not_configured"]);
    const current = schedule.assignments.find(
      (assignment) =>
        assignment.employeeId === request.employeeId &&
        assignment.date === request.startDate,
    );
    if (current?.shiftCode === shiftCode)
      return result("possible", ["preferred_shift_unchanged"]);
    assignments = schedule.assignments.filter(
      (assignment) =>
        assignment.employeeId !== request.employeeId ||
        assignment.date !== request.startDate,
    );
    assignments.push({
      employeeId: request.employeeId,
      date: request.startDate,
      shiftCode,
    });
  } else {
    const requestDates = datesBetween(request.startDate, request.endDate);
    const retained = schedule.assignments.filter(
      (assignment) =>
        assignment.employeeId !== request.employeeId ||
        !requestDates.has(assignment.date),
    );
    if (retained.length === schedule.assignments.length)
      return result("possible", ["already_unassigned"]);
    assignments = retained;
  }

  const simulated = validateSchedule(input, assignments, adjacent);
  if (worsensCoverage(baseline.shortages, simulated.shortages))
    return result("conflict", ["coverage_shortage"]);

  if (request.kind === "preferred_shift" && simulated.issues.length)
    return result("conflict", [
      "schedule_constraint_conflict",
      ...new Set(simulated.issues),
    ]);

  return result("possible", [
    request.kind === "preferred_shift"
      ? "preferred_shift_available"
      : "request_preserves_coverage",
  ]);
}

/** True when a published roster contradicts an already approved request. */
export function assignmentConflictsWithApprovedRequest(
  request: ScheduleRequestEvaluationInput,
  assignments: ShiftAssignment[],
): boolean {
  if (request.kind === "preferred_shift")
    return !assignments.some(
      (assignment) =>
        assignment.employeeId === request.employeeId &&
        assignment.date === request.startDate &&
        assignment.shiftCode === request.shiftCode,
    );
  const requestDates = datesBetween(request.startDate, request.endDate);
  return assignments.some(
    (assignment) =>
      assignment.employeeId === request.employeeId &&
      requestDates.has(assignment.date),
  );
}
