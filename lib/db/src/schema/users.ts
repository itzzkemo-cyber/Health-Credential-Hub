import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  jsonb,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { facilitiesTable } from "./facilities";

export const USER_ROLES = [
  "employee",
  "supervisor",
  "department_manager",
  "hospital_admin",
  "system_admin",
] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  nameAr: text("name_ar").notNull(),
  role: text("role", { enum: USER_ROLES }).notNull().default("employee"),
  departmentId: integer("department_id"),
  supervisorId: integer("supervisor_id"),
  facilityId: integer("facility_id")
    .notNull()
    .references(() => facilitiesTable.id),
  jobTitle: text("job_title").notNull().default(""),
  jobTitleAr: text("job_title_ar").notNull().default(""),
  employeeNumber: text("employee_number").notNull().default(""),
  phone: text("phone"),
  avatarUrl: text("avatar_url"),
  // Google account id (OAuth `sub` claim) — set once the user signs in with
  // Google; lets future Google logins skip the password entirely.
  // Legacy nullable external identity retained for migration compatibility.
  // No public OAuth route exists in the production web release.
  googleId: text("google_id").unique(),
  isActive: boolean("is_active").notNull().default(true),
  // Administratively provisioned accounts must replace their temporary
  // password before accessing workforce or credential data.
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  // Bumped on password reset/change to instantly revoke all issued sessions.
  sessionVersion: integer("session_version").notNull().default(0),
  // --- Two-factor authentication (TOTP) ---
  // Base32 shared secret; only set once the user confirmed a first OTP.
  totpSecret: text("totp_secret"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  // sha256 hashes of the single-use backup codes still available.
  backupCodes: jsonb("backup_codes").$type<string[]>(),
  // Highest 30s time-step already accepted — rejects replayed OTPs.
  totpLastUsedStep: integer("totp_last_used_step"),
  notificationPrefs: jsonb("notification_prefs")
    .$type<number[]>()
    .notNull()
    .default([90, 60, 30, 15, 7, 1]),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  check(
    "users_totp_enabled_requires_secret",
    sql`not ${table.totpEnabled} or ${table.totpSecret} is not null`,
  ),
]);

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
