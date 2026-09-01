import {
  ApiError,
  type CreateShiftRequestInput,
  type CreateShiftRequestInputKind,
  type ScheduleRequestDecisionInput,
  type ScheduleRequestFeasibilityStatus,
  type ScheduleRequestVersionInput,
  type ShiftRequestStatus,
} from "@workspace/api-client-react";

export type ScheduleRequestKind = CreateShiftRequestInputKind;
export type ScheduleRequestStatus = ShiftRequestStatus;
export type ScheduleRequestFeasibility = ScheduleRequestFeasibilityStatus;

export interface ScheduleRequestFormValue {
  kind: ScheduleRequestKind;
  startDate: string;
  endDate: string;
  shiftCode: string;
  note: string;
}

export type ScheduleRequestValidationKey =
  | "required"
  | "dates"
  | "single_day"
  | "shift"
  | "note";

const DATE = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const SHIFT_CODE = /^[A-Z][A-Z0-9_-]{0,7}$/;
const DAY_MS = 24 * 60 * 60 * 1_000;

function dateValue(value: string): number | null {
  if (!DATE.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
    ? timestamp
    : null;
}

export function validateScheduleRequestForm(
  form: ScheduleRequestFormValue,
): ScheduleRequestValidationKey | null {
  if (!form.kind || !form.startDate || !form.endDate) return "required";
  const start = dateValue(form.startDate);
  const end = dateValue(form.endDate);
  if (
    start === null ||
    end === null ||
    start > end ||
    form.startDate.slice(0, 7) !== form.endDate.slice(0, 7) ||
    (end - start) / DAY_MS + 1 > 31
  )
    return "dates";
  if (form.kind !== "leave" && form.startDate !== form.endDate)
    return "single_day";
  if (
    form.kind === "preferred_shift" &&
    !SHIFT_CODE.test(form.shiftCode.trim().toUpperCase())
  )
    return "shift";
  if (form.note.trim().length > 500) return "note";
  return null;
}

export function toCreateScheduleRequestInput(
  form: ScheduleRequestFormValue,
): CreateShiftRequestInput {
  return {
    kind: form.kind,
    startDate: form.startDate,
    endDate: form.kind === "leave" ? form.endDate : form.startDate,
    ...(form.kind === "preferred_shift"
      ? { shiftCode: form.shiftCode.trim().toUpperCase() }
      : {}),
    ...(form.note.trim() ? { note: form.note.trim() } : {}),
  };
}

export function scheduleRequestVersionInput(
  version: number,
): ScheduleRequestVersionInput {
  return { expectedVersion: version };
}

export function scheduleRequestDecisionInput(
  version: number,
  decision: "approved" | "rejected",
): ScheduleRequestDecisionInput {
  return { expectedVersion: version, decision };
}

export function requestErrorKey(
  error: unknown,
): "approved_conflict" | "conflict" | "forbidden" | "invalid" | "error" {
  if (!(error instanceof ApiError)) return "error";
  if (error.status === 403 || error.status === 404) return "forbidden";
  if (
    error.status === 409 &&
    (error.data as { code?: string } | null)?.code ===
      "conflicting_approved_schedule_request"
  )
    return "approved_conflict";
  if (error.status === 409) return "conflict";
  if (error.status === 400 || error.status === 422 || error.status === 428)
    return "invalid";
  return "error";
}

export function requestReasonTranslationKey(code: string): string {
  const known = new Set([
    "schedule_not_found",
    "employee_not_in_schedule",
    "already_unassigned",
    "request_preserves_coverage",
    "coverage_shortage",
    "shift_not_configured",
    "preferred_shift_unchanged",
    "preferred_shift_available",
    "published_schedule_requires_reopen",
    "schedule_constraint_conflict",
    "duplicate_employee_day",
    "monthly_shift_limit",
    "minimum_rest",
    "overlapping_shifts",
    "consecutive_day_limit",
    "employee_unavailable",
    "invalid_adjacent_assignments",
    "invalid_assignments",
    "invalid_assignment",
  ]);
  return known.has(code)
    ? `schedules.request_reason_${code}`
    : "schedules.request_reason_generic";
}

export function canWithdrawScheduleRequest(status: ScheduleRequestStatus) {
  return status === "pending";
}

export function canReviewScheduleRequest({
  status,
  employeeId,
  reviewerId,
  manager,
}: {
  status: ScheduleRequestStatus;
  employeeId: number;
  reviewerId?: number;
  manager: boolean;
}) {
  return (
    manager &&
    status === "pending" &&
    reviewerId !== undefined &&
    reviewerId !== employeeId
  );
}

export function canRevokeApprovedScheduleRequest({
  status,
  employeeId,
  reviewerId,
  manager,
}: {
  status: ScheduleRequestStatus;
  employeeId: number;
  reviewerId?: number;
  manager: boolean;
}) {
  return (
    manager &&
    status === "approved" &&
    reviewerId !== undefined &&
    reviewerId !== employeeId
  );
}
