import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  integer,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { facilitiesTable } from "./facilities";

export interface ScheduleConfiguration {
  employeeIds: number[];
  shiftTypes: Array<{
    code: string;
    label: string;
    labelAr: string;
    startTime: string;
    endTime: string;
    requiredPerDay: number;
  }>;
  constraints: {
    minRestHours: number;
    maxConsecutiveDays: number;
    maxShiftsPerMonth: number;
  };
  unavailability: Array<{ employeeId: number; date: string }>;
}
export interface StoredShiftAssignment {
  employeeId: number;
  date: string;
  shiftCode: string;
}

// Workforce planning records are durable; no destructive schedule endpoint.
export const shiftSchedulesTable = pgTable(
  "shift_schedules",
  {
    id: serial("id").primaryKey(),
    facilityId: integer("facility_id")
      .notNull()
      .references(() => facilitiesTable.id),
    title: text("title").notNull(),
    month: text("month").notNull(),
    status: text("status", { enum: ["draft", "published", "cancelled"] })
      .notNull()
      .default("draft"),
    rowVersion: integer("row_version").notNull().default(1),
    configuration: jsonb("configuration")
      .$type<ScheduleConfiguration>()
      .notNull(),
    assignments: jsonb("assignments")
      .$type<StoredShiftAssignment[]>()
      .notNull()
      .default([]),
    createdBy: integer("created_by")
      .notNull()
      .references(() => usersTable.id),
    updatedBy: integer("updated_by")
      .notNull()
      .references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("shift_schedules_facility_month_idx").on(
      table.facilityId,
      table.month,
    ),
    uniqueIndex("shift_schedules_id_month_uidx").on(table.id, table.month),
    check(
      "shift_schedules_month_format",
      sql`${table.month} ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'`,
    ),
    check(
      "shift_schedules_status_valid",
      sql`${table.status} in ('draft', 'published', 'cancelled')`,
    ),
    check("shift_schedules_version_positive", sql`${table.rowVersion} >= 1`),
    check(
      "shift_schedules_title_length",
      sql`char_length(${table.title}) between 1 and 120`,
    ),
    check(
      "shift_schedules_configuration_object",
      sql`jsonb_typeof(${table.configuration}) = 'object'`,
    ),
    check(
      "shift_schedules_assignments_array",
      sql`jsonb_typeof(${table.assignments}) = 'array' and jsonb_array_length(${table.assignments}) <= 6200`,
    ),
  ],
);

// The unique membership key prevents the same employee from receiving two
// independent rosters for a month, including under concurrent requests.
export const shiftScheduleMembersTable = pgTable(
  "shift_schedule_members",
  {
    id: serial("id").primaryKey(),
    scheduleId: integer("schedule_id").notNull(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => usersTable.id),
    month: text("month").notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "shift_schedule_members_schedule_month_fk",
      columns: [table.scheduleId, table.month],
      foreignColumns: [shiftSchedulesTable.id, shiftSchedulesTable.month],
    }),
    uniqueIndex("shift_schedule_members_employee_month_uidx")
      .on(table.employeeId, table.month)
      .where(sql`${table.releasedAt} is null`),
    index("shift_schedule_members_schedule_idx").on(table.scheduleId),
  ],
);

export type ShiftScheduleRow = typeof shiftSchedulesTable.$inferSelect;
