/** Bounded, deterministic planning assistance. No clinical or legal eligibility decisions. */
export interface ShiftType {
  code: string;
  label: string;
  labelAr: string;
  startTime: string;
  endTime: string;
  requiredPerDay: number;
}

export interface ShiftAssignment {
  employeeId: number;
  date: string;
  shiftCode: string;
}

export interface AdjacentAssignment {
  employeeId: number;
  date: string;
  startTime: string;
  endTime: string;
  minRestHours?: number;
  maxConsecutiveDays?: number;
}

export interface SchedulePlanningInput {
  title: string;
  month: string;
  employeeIds: number[];
  shiftTypes: ShiftType[];
  constraints: {
    minRestHours: number;
    maxConsecutiveDays: number;
    maxShiftsPerMonth: number;
  };
  unavailability: { employeeId: number; date: string }[];
}

export interface ScheduleShortage {
  date: string;
  shiftCode: string;
  required: number;
  assigned: number;
}

export interface SchedulePlan {
  assignments: ShiftAssignment[];
  shortages: ScheduleShortage[];
  warnings: string[];
}

export class SchedulePlanningError extends Error {
  constructor(public readonly issues: string[]) {
    super("Invalid scheduling input");
    this.name = "SchedulePlanningError";
  }
}

const DAY_MS = 86_400_000;
const DAY_MINUTES = 1_440;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const CODE = /^[A-Z][A-Z0-9_-]{0,7}$/;
const LIMIT_EMPLOYEES = 200;
const LIMIT_SHIFTS = 6;
const BASE_WARNINGS = ["planning_assistance_only", "boundary_review_required"];

function dayNumber(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

function isDate(date: string): boolean {
  if (!DATE.test(date)) return false;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === date
  );
}

function minutes(time: string): number {
  const [hours, mins] = time.split(":").map(Number);
  return hours! * 60 + mins!;
}

function duration(shift: Pick<ShiftType, "startTime" | "endTime">): number {
  return (
    (minutes(shift.endTime) - minutes(shift.startTime) + DAY_MINUTES) %
    DAY_MINUTES
  );
}

function integer(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

export function scheduleMonthDates(month: string): string[] {
  if (!MONTH.test(month)) return [];
  const [year, monthNumber] = month.split("-").map(Number);
  const count = new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
  return Array.from(
    { length: count },
    (_, day) => `${month}-${String(day + 1).padStart(2, "0")}`,
  );
}

/** API validation also rejects unknown properties. These checks protect the engine itself. */
export function validatePlanningInput(input: SchedulePlanningInput): string[] {
  const issues = new Set<string>();
  if (!input || typeof input !== "object") return ["invalid_input"];
  if (
    typeof input.title !== "string" ||
    !input.title.trim() ||
    input.title.length > 120
  )
    issues.add("invalid_title");
  if (typeof input.month !== "string" || !MONTH.test(input.month))
    issues.add("invalid_month");
  if (
    !Array.isArray(input.employeeIds) ||
    input.employeeIds.length < 1 ||
    input.employeeIds.length > LIMIT_EMPLOYEES
  ) {
    issues.add("invalid_employees");
  } else if (
    input.employeeIds.some((id) => !integer(id, 1, 2_147_483_647)) ||
    new Set(input.employeeIds).size !== input.employeeIds.length
  ) {
    issues.add("invalid_employees");
  }
  if (
    !Array.isArray(input.shiftTypes) ||
    input.shiftTypes.length < 1 ||
    input.shiftTypes.length > LIMIT_SHIFTS
  ) {
    issues.add("invalid_shifts");
  } else {
    const codes = new Set<string>();
    for (const shift of input.shiftTypes) {
      if (
        !shift ||
        !CODE.test(shift.code) ||
        codes.has(shift.code.toUpperCase()) ||
        !TIME.test(shift.startTime) ||
        !TIME.test(shift.endTime)
      ) {
        issues.add("invalid_shifts");
        continue;
      }
      codes.add(shift.code.toUpperCase());
      if (
        !integer(shift.requiredPerDay, 0, LIMIT_EMPLOYEES) ||
        duration(shift) <= 0 ||
        duration(shift) > 16 * 60
      )
        issues.add("invalid_shifts");
      if (
        typeof shift.label !== "string" ||
        !shift.label.trim() ||
        shift.label.length > 80 ||
        typeof shift.labelAr !== "string" ||
        !shift.labelAr.trim() ||
        shift.labelAr.length > 80
      )
        issues.add("invalid_shifts");
    }
    if (input.shiftTypes.every((shift) => shift?.requiredPerDay === 0))
      issues.add("coverage_required");
  }
  if (
    !input.constraints ||
    !integer(input.constraints.minRestHours, 0, 24) ||
    !integer(input.constraints.maxConsecutiveDays, 1, 31) ||
    !integer(input.constraints.maxShiftsPerMonth, 1, 31)
  )
    issues.add("invalid_constraints");
  if (
    !Array.isArray(input.unavailability) ||
    input.unavailability.length > LIMIT_EMPLOYEES * 31
  ) {
    issues.add("invalid_unavailability");
  } else {
    const employees = new Set(
      Array.isArray(input.employeeIds) ? input.employeeIds : [],
    );
    const seen = new Set<string>();
    for (const unavailable of input.unavailability) {
      if (
        !unavailable ||
        !employees.has(unavailable.employeeId) ||
        typeof unavailable.date !== "string" ||
        !isDate(unavailable.date) ||
        !unavailable.date.startsWith(`${input.month}-`)
      ) {
        issues.add("invalid_unavailability");
        continue;
      }
      const key = `${unavailable.employeeId}:${unavailable.date}`;
      if (seen.has(key)) issues.add("invalid_unavailability");
      seen.add(key);
    }
  }
  return [...issues];
}

type Interval = {
  day: number;
  start: number;
  end: number;
  minRestHours?: number;
  maxConsecutiveDays?: number;
};
type EmployeeState = {
  intervals: Interval[];
  days: Set<number>;
  count: number;
  minutes: number;
  byShift: Map<string, number>;
};

function interval(
  date: string,
  shift: Pick<ShiftType, "startTime" | "endTime">,
): Interval {
  const day = dayNumber(date);
  const start = day * DAY_MINUTES + minutes(shift.startTime);
  return { day, start, end: start + duration(shift) };
}

function prepare(input: SchedulePlanningInput, adjacent: AdjacentAssignment[]) {
  const state = new Map<number, EmployeeState>(
    input.employeeIds.map((id) => [
      id,
      {
        intervals: [],
        days: new Set(),
        count: 0,
        minutes: 0,
        byShift: new Map(),
      },
    ]),
  );
  const issues: string[] = [];
  const firstDay = dayNumber(`${input.month}-01`);
  const lastDay = firstDay + scheduleMonthDates(input.month).length - 1;
  if (!Array.isArray(adjacent) || adjacent.length > LIMIT_EMPLOYEES * 62)
    return { state, issues: ["invalid_adjacent_assignments"] };
  for (const assignment of adjacent) {
    if (
      !assignment ||
      !isDate(assignment.date) ||
      !TIME.test(assignment.startTime) ||
      !TIME.test(assignment.endTime) ||
      duration(assignment) <= 0 ||
      duration(assignment) > 16 * 60 ||
      (assignment.minRestHours !== undefined &&
        !integer(assignment.minRestHours, 0, 24)) ||
      (assignment.maxConsecutiveDays !== undefined &&
        !integer(assignment.maxConsecutiveDays, 1, 31))
    ) {
      issues.push("invalid_adjacent_assignments");
      continue;
    }
    const employee = state.get(assignment.employeeId);
    if (!employee) continue;
    const span = {
      ...interval(assignment.date, assignment),
      minRestHours: assignment.minRestHours,
      maxConsecutiveDays: assignment.maxConsecutiveDays,
    };
    if (span.day >= firstDay && span.day <= lastDay) {
      issues.push("invalid_adjacent_assignments");
      continue;
    }
    // Only a month either side is needed for <=31 consecutive days and <=24h rest.
    if (span.day < firstDay - 31 || span.day > lastDay + 31) continue;
    if (employee.days.has(span.day))
      issues.push("invalid_adjacent_assignments");
    employee.intervals.push(span);
    employee.days.add(span.day);
  }
  for (const employee of state.values())
    employee.intervals.sort((a, b) => a.start - b.start);
  return { state, issues: [...new Set(issues)] };
}

function assignmentIssue(
  employee: EmployeeState,
  span: Interval,
  constraints: SchedulePlanningInput["constraints"],
): string | null {
  if (employee.days.has(span.day)) return "duplicate_employee_day";
  if (employee.count >= constraints.maxShiftsPerMonth)
    return "monthly_shift_limit";
  for (const existing of employee.intervals) {
    const rest =
      Math.max(constraints.minRestHours, existing.minRestHours ?? 0) * 60;
    if (span.start >= existing.end) {
      if (span.start - existing.end < rest) return "minimum_rest";
    } else if (existing.start >= span.end) {
      if (existing.start - span.end < rest) return "minimum_rest";
    } else {
      return "overlapping_shifts";
    }
  }
  let first = span.day;
  let last = span.day;
  while (employee.days.has(first - 1)) first--;
  while (employee.days.has(last + 1)) last++;
  let limit = constraints.maxConsecutiveDays;
  for (const existing of employee.intervals) {
    if (existing.day >= first && existing.day <= last)
      limit = Math.min(limit, existing.maxConsecutiveDays ?? limit);
  }
  if (last - first + 1 > limit) return "consecutive_day_limit";
  return null;
}

function assign(
  employee: EmployeeState,
  span: Interval,
  shiftCode: string,
): void {
  employee.intervals.push(span);
  employee.days.add(span.day);
  employee.count++;
  employee.minutes += span.end - span.start;
  employee.byShift.set(shiftCode, (employee.byShift.get(shiftCode) ?? 0) + 1);
}

function coverage(
  input: SchedulePlanningInput,
  assignments: ShiftAssignment[],
): ScheduleShortage[] {
  const assignedCounts = new Map<string, number>();
  for (const assignment of assignments) {
    const key = `${assignment.date}:${assignment.shiftCode}`;
    assignedCounts.set(key, (assignedCounts.get(key) ?? 0) + 1);
  }
  return scheduleMonthDates(input.month).flatMap((date) =>
    input.shiftTypes.flatMap((shift) => {
      const assigned = assignedCounts.get(`${date}:${shift.code}`) ?? 0;
      return assigned < shift.requiredPerDay
        ? [
            {
              date,
              shiftCode: shift.code,
              required: shift.requiredPerDay,
              assigned,
            },
          ]
        : [];
    }),
  );
}

function warnings(shortages: ScheduleShortage[]): string[] {
  return [...BASE_WARNINGS, ...(shortages.length ? ["coverage_shortage"] : [])];
}

export function validateSchedule(
  input: SchedulePlanningInput,
  assignments: ShiftAssignment[],
  adjacent: AdjacentAssignment[] = [],
) {
  const inputIssues = validatePlanningInput(input);
  if (inputIssues.length)
    return {
      valid: false,
      issues: inputIssues,
      shortages: [],
      warnings: [...BASE_WARNINGS],
    };
  const { state, issues: contextIssues } = prepare(input, adjacent);
  const issues = new Set(contextIssues);
  if (
    !Array.isArray(assignments) ||
    assignments.length > input.employeeIds.length * 31
  )
    return {
      valid: false,
      issues: ["invalid_assignments"],
      shortages: [],
      warnings: [...BASE_WARNINGS],
    };
  const shifts = new Map(input.shiftTypes.map((shift) => [shift.code, shift]));
  const unavailable = new Set(
    input.unavailability.map((entry) => `${entry.employeeId}:${entry.date}`),
  );
  const validAssignments: ShiftAssignment[] = [];
  // Validation is deterministic even when a client sends rows in a different order.
  const ordered = [...assignments].sort(
    (a, b) =>
      String(a?.date).localeCompare(String(b?.date)) ||
      (a?.employeeId ?? 0) - (b?.employeeId ?? 0),
  );
  for (const assignment of ordered) {
    if (
      !assignment ||
      !state.has(assignment.employeeId) ||
      !isDate(assignment.date) ||
      !assignment.date.startsWith(`${input.month}-`) ||
      !shifts.has(assignment.shiftCode)
    ) {
      issues.add("invalid_assignment");
      continue;
    }
    if (unavailable.has(`${assignment.employeeId}:${assignment.date}`))
      issues.add("employee_unavailable");
    const employee = state.get(assignment.employeeId)!;
    const span = interval(assignment.date, shifts.get(assignment.shiftCode)!);
    const issue = assignmentIssue(employee, span, input.constraints);
    if (issue) issues.add(issue);
    assign(employee, span, assignment.shiftCode);
    validAssignments.push(assignment);
  }
  const shortages = coverage(input, validAssignments);
  return {
    valid: issues.size === 0,
    issues: [...issues],
    shortages,
    warnings: warnings(shortages),
  };
}

/** Greedy balanced proposal, not an optimizer: unfilled shifts always remain explicit. */
export function generateSchedule(
  input: SchedulePlanningInput,
  adjacent: AdjacentAssignment[] = [],
): SchedulePlan {
  const inputIssues = validatePlanningInput(input);
  if (inputIssues.length) throw new SchedulePlanningError(inputIssues);
  const { state, issues } = prepare(input, adjacent);
  if (issues.length) throw new SchedulePlanningError(issues);
  const ids = [...input.employeeIds].sort((a, b) => a - b);
  const unavailable = new Set(
    input.unavailability.map((entry) => `${entry.employeeId}:${entry.date}`),
  );
  const shifts = [...input.shiftTypes].sort(
    (a, b) =>
      minutes(a.startTime) - minutes(b.startTime) ||
      a.code.localeCompare(b.code),
  );
  const assignments: ShiftAssignment[] = [];
  const dates = scheduleMonthDates(input.month);
  for (const [dayIndex, date] of dates.entries()) {
    for (const [shiftIndex, shift] of shifts.entries()) {
      const span = interval(date, shift);
      const offset = (dayIndex + shiftIndex) % ids.length;
      const candidates = ids
        .map((id, index) => ({
          id,
          employee: state.get(id)!,
          rank: (index - offset + ids.length) % ids.length,
        }))
        .filter(
          ({ id, employee }) =>
            !unavailable.has(`${id}:${date}`) &&
            !assignmentIssue(employee, span, input.constraints),
        )
        .sort(
          (a, b) =>
            a.employee.minutes - b.employee.minutes ||
            (a.employee.byShift.get(shift.code) ?? 0) -
              (b.employee.byShift.get(shift.code) ?? 0) ||
            a.employee.count - b.employee.count ||
            a.rank - b.rank,
        );
      for (const candidate of candidates.slice(0, shift.requiredPerDay)) {
        assign(candidate.employee, span, shift.code);
        assignments.push({
          employeeId: candidate.id,
          date,
          shiftCode: shift.code,
        });
      }
    }
  }
  const shortages = coverage(input, assignments);
  return { assignments, shortages, warnings: warnings(shortages) };
}
