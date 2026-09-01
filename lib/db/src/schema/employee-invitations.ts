import {
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { departmentsTable } from "./departments";
import { facilitiesTable } from "./facilities";
import { USER_ROLES, usersTable } from "./users";

/**
 * Administrator-issued, single-use employee invitations.
 *
 * The bearer token itself is never persisted: only its SHA-256 digest is
 * stored. Profile and organization fields are authoritative so the public
 * acceptance endpoint cannot choose a role, facility, department, or
 * supervisor.
 */
export const employeeInvitationsTable = pgTable(
  "employee_invitations",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedBy: integer("invited_by")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    facilityId: integer("facility_id")
      .notNull()
      .references(() => facilitiesTable.id, { onDelete: "restrict" }),
    role: text("role", { enum: USER_ROLES }).notNull().default("employee"),
    departmentId: integer("department_id").references(
      () => departmentsTable.id,
      { onDelete: "restrict" },
    ),
    supervisorId: integer("supervisor_id").references(() => usersTable.id, {
      onDelete: "restrict",
    }),
    name: text("name").notNull(),
    nameAr: text("name_ar").notNull(),
    jobTitle: text("job_title").notNull(),
    jobTitleAr: text("job_title_ar").notNull(),
    employeeNumber: text("employee_number").notNull(),
    phone: text("phone"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedUserId: integer("accepted_user_id").references(
      () => usersTable.id,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("employee_invitations_token_hash_unique").on(table.tokenHash),
    index("employee_invitations_email_active_idx").on(
      table.email,
      table.acceptedAt,
      table.revokedAt,
    ),
    index("employee_invitations_expiry_idx").on(table.expiresAt),
    check(
      "employee_invitations_email_normalized",
      sql`${table.email} = lower(${table.email}) and ${table.email} = btrim(${table.email})`,
    ),
    check(
      "employee_invitations_token_hash_format",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "employee_invitations_terminal_state",
      sql`not (${table.acceptedAt} is not null and ${table.revokedAt} is not null)
        and ((${table.acceptedAt} is null and ${table.acceptedUserId} is null)
          or (${table.acceptedAt} is not null and ${table.acceptedUserId} is not null))`,
    ),
    check(
      "employee_invitations_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "employee_invitations_assignable_role",
      sql`${table.role} in ('employee', 'supervisor', 'department_manager', 'hospital_admin')`,
    ),
  ],
);

export type EmployeeInvitation = typeof employeeInvitationsTable.$inferSelect;
