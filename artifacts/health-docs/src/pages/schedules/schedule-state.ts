import {
  ApiError,
  type Employee,
  type Schedule,
  type ScheduleShortage,
  type ShiftAssignment,
  type ShiftType,
} from "@workspace/api-client-react";

export function canManageSchedules(role?: string): boolean {
  return [
    "supervisor",
    "department_manager",
    "hospital_admin",
    "system_admin",
  ].includes(role ?? "");
}

export function currentMonth(now = new Date()): string {
  // Scheduling uses the same Riyadh wall clock as the API, not the viewer's
  // device timezone or locale calendar. Keep the contract value ASCII YYYY-MM.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Riyadh",
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  return `${parts.find((part) => part.type === "year")!.value}-${parts.find((part) => part.type === "month")!.value}`;
}

export function monthDates(month: string): string[] {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) return [];
  const [year, index] = month.split("-").map(Number);
  const days = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return Array.from(
    { length: days },
    (_, day) => `${month}-${String(day + 1).padStart(2, "0")}`,
  );
}

export function dateRange(month: string, from: string, to: string): string[] {
  const dates = monthDates(month);
  if (from > to || !dates.includes(from) || !dates.includes(to)) return [];
  return dates.filter((date) => date >= from && date <= to);
}

export function employeeName(
  employee: Pick<Employee, "name" | "nameAr">,
  arabic: boolean,
): string {
  return arabic
    ? employee.nameAr || employee.name
    : employee.name || employee.nameAr;
}

export function shiftName(
  shift: Pick<ShiftType, "label" | "labelAr">,
  arabic: boolean,
): string {
  return arabic ? shift.labelAr || shift.label : shift.label || shift.labelAr;
}

export function cellKey(employeeId: number, date: string): string {
  return `${employeeId}:${date}`;
}

export function replaceAssignment(
  assignments: ShiftAssignment[],
  employeeId: number,
  date: string,
  shiftCode: string,
): ShiftAssignment[] {
  const next = assignments.filter(
    (item) => item.employeeId !== employeeId || item.date !== date,
  );
  return shiftCode ? [...next, { employeeId, date, shiftCode }] : next;
}

export function assignmentSignature(assignments: ShiftAssignment[]): string {
  return assignments
    .map(
      ({ employeeId, date, shiftCode }) =>
        `${cellKey(employeeId, date)}:${shiftCode}`,
    )
    .sort()
    .join("|");
}

/** A coverage preview only; the API remains authoritative for all constraints. */
export function coveragePreview(
  month: string,
  shiftTypes: ShiftType[],
  assignments: ShiftAssignment[],
): ScheduleShortage[] {
  const counts = new Map<string, number>();
  for (const assignment of assignments) {
    const key = `${assignment.date}:${assignment.shiftCode}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return monthDates(month).flatMap((date) =>
    shiftTypes.map((shift) => ({
      date,
      shiftCode: shift.code,
      required: shift.requiredPerDay,
      assigned: counts.get(`${date}:${shift.code}`) ?? 0,
    })),
  );
}

export function rosterCapacity(
  schedule: Pick<Schedule, "month" | "employeeIds" | "shiftTypes" | "constraints">,
): { required: number; available: number; minimumEmployees: number } {
  const requiredPerDay = schedule.shiftTypes.reduce(
    (sum, shift) => sum + shift.requiredPerDay,
    0,
  );
  const required = monthDates(schedule.month).length * requiredPerDay;
  const perEmployee = Math.max(1, schedule.constraints.maxShiftsPerMonth);
  return {
    required,
    available: schedule.employeeIds.length * perEmployee,
    minimumEmployees: Math.ceil(required / perEmployee),
  };
}

export function scheduleIssueKey(code: string): string {
  const keys: Record<string, string> = {
    monthly_shift_limit: "issue_monthly_shift_limit",
    minimum_rest: "issue_minimum_rest",
    insufficient_rest: "issue_minimum_rest",
    consecutive_day_limit: "issue_consecutive_day_limit",
    employee_unavailable: "issue_employee_unavailable",
    overlapping_shifts: "issue_overlapping_shifts",
    duplicate_employee_day: "issue_duplicate_employee_day",
    invalid_adjacent_assignments: "issue_adjacent",
    coverage_shortage: "issue_coverage",
    approved_request_conflict: "issue_request_conflict",
  };
  return keys[code.toLowerCase()] ?? "invalid";
}

export function canPublish(
  schedule: Schedule,
  assignments: ShiftAssignment[],
  pending: boolean,
  conflict: boolean,
): boolean {
  return (
    schedule.status === "draft" &&
    !pending &&
    !conflict &&
    assignmentSignature(schedule.assignments) ===
      assignmentSignature(assignments) &&
    schedule.issues.length === 0 &&
    schedule.shortages.length === 0
  );
}

export function scheduleErrorKey(error: unknown, creating = false): string {
  if (!(error instanceof ApiError)) return creating ? "create_error" : "failed";
  const code = (
    (error.data as { code?: string } | null)?.code ?? ""
  ).toUpperCase();
  if (error.status === 403 || error.status === 404) return "forbidden";
  if (/VERSION_CONFLICT|INVALID_SCHEDULE_STATUS/.test(code)) return "conflict";
  if (/EMPLOYEE_MONTH_ALREADY_SCHEDULED/.test(code)) return "overlap";
  const issueKey = scheduleIssueKey(code);
  if (issueKey !== "invalid") return issueKey;
  if (error.status === 409) return "invalid";
  if (error.status === 400 || error.status === 422) return "invalid";
  return creating ? "create_error" : "failed";
}
