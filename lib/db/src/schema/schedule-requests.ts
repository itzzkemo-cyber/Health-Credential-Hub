import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  integer,
  text,
  jsonb,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { facilitiesTable } from "./facilities";
import { shiftSchedulesTable } from "./shift-schedules";
import { usersTable } from "./users";

export const SCHEDULE_REQUEST_KINDS = [
  "leave",
  "preferred_shift",
  "off",
  "eo",
] as const;
export type ScheduleRequestKind = (typeof SCHEDULE_REQUEST_KINDS)[number];

export const SCHEDULE_REQUEST_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "withdrawn",
] as const;
export type ScheduleRequestStatus = (typeof SCHEDULE_REQUEST_STATUSES)[number];

export const SCHEDULE_REQUEST_FEASIBILITY_STATUSES = [
  "possible",
  "conflict",
  "unknown",
] as const;
export type ScheduleRequestFeasibilityStatus =
  (typeof SCHEDULE_REQUEST_FEASIBILITY_STATUSES)[number];

// Employee workforce requests are durable records. The free-form note is
// intentionally not copied into audit events or notifications.
export const scheduleRequestsTable = pgTable(
  "schedule_requests",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => usersTable.id),
    facilityId: integer("facility_id")
      .notNull()
      .references(() => facilitiesTable.id),
    kind: text("kind", { enum: SCHEDULE_REQUEST_KINDS }).notNull(),
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    shiftCode: text("shift_code"),
    note: text("note"),
    status: text("status", { enum: SCHEDULE_REQUEST_STATUSES })
      .notNull()
      .default("pending"),
    rowVersion: integer("row_version").notNull().default(1),
    feasibilityStatus: text("feasibility_status", {
      enum: SCHEDULE_REQUEST_FEASIBILITY_STATUSES,
    })
      .notNull()
      .default("unknown"),
    feasibilityReasonCodes: jsonb("feasibility_reason_codes")
      .$type<string[]>()
      .notNull()
      .default([]),
    evaluatedScheduleId: integer("evaluated_schedule_id").references(
      () => shiftSchedulesTable.id,
    ),
    evaluatedScheduleVersion: integer("evaluated_schedule_version"),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull(),
    decidedBy: integer("decided_by").references(() => usersTable.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("schedule_requests_employee_created_idx").on(
      table.employeeId,
      table.createdAt,
    ),
    index("schedule_requests_facility_status_created_idx").on(
      table.facilityId,
      table.status,
      table.createdAt,
    ),
    index("schedule_requests_schedule_idx").on(table.evaluatedScheduleId),
    check(
      "schedule_requests_kind_valid",
      sql`${table.kind} in ('leave', 'preferred_shift', 'off', 'eo')`,
    ),
    check(
      "schedule_requests_status_valid",
      sql`${table.status} in ('pending', 'approved', 'rejected', 'withdrawn')`,
    ),
    check(
      "schedule_requests_feasibility_valid",
      sql`${table.feasibilityStatus} in ('possible', 'conflict', 'unknown')`,
    ),
    check(
      "schedule_requests_start_date_format",
      sql`${table.startDate} ~ '^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'`,
    ),
    check(
      "schedule_requests_end_date_format",
      sql`${table.endDate} ~ '^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'`,
    ),
    check(
      "schedule_requests_date_order",
      sql`${table.endDate} >= ${table.startDate}`,
    ),
    check(
      "schedule_requests_single_month",
      sql`left(${table.startDate}, 7) = left(${table.endDate}, 7)`,
    ),
    check(
      "schedule_requests_kind_shape",
      sql`(${table.kind} = 'leave' or ${table.startDate} = ${table.endDate}) and ((${table.kind} = 'preferred_shift' and ${table.shiftCode} ~ '^[A-Z][A-Z0-9_-]{0,7}$') or (${table.kind} <> 'preferred_shift' and ${table.shiftCode} is null))`,
    ),
    check(
      "schedule_requests_note_length",
      sql`${table.note} is null or char_length(${table.note}) between 1 and 500`,
    ),
    check("schedule_requests_version_positive", sql`${table.rowVersion} >= 1`),
    check(
      "schedule_requests_feasibility_reasons_array",
      sql`jsonb_typeof(${table.feasibilityReasonCodes}) = 'array' and jsonb_array_length(${table.feasibilityReasonCodes}) <= 20`,
    ),
    check(
      "schedule_requests_schedule_snapshot_complete",
      sql`(${table.evaluatedScheduleId} is null and ${table.evaluatedScheduleVersion} is null) or (${table.evaluatedScheduleId} is not null and ${table.evaluatedScheduleVersion} >= 1)`,
    ),
    check(
      "schedule_requests_decision_shape",
      sql`(${table.status} in ('approved', 'rejected') and ${table.decidedBy} is not null and ${table.decidedAt} is not null) or (${table.status} in ('pending', 'withdrawn') and ${table.decidedBy} is null and ${table.decidedAt} is null)`,
    ),
  ],
);

export type ScheduleRequestRow = typeof scheduleRequestsTable.$inferSelect;
