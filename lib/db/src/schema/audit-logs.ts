import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { facilitiesTable } from "./facilities";

export const auditLogsTable = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    // Persist the tenant affected by the event. Deriving tenant scope from
    // the actor is unsafe for cross-facility system-administrator actions.
    facilityId: integer("facility_id").references(() => facilitiesTable.id),
    userName: text("user_name").notNull(),
    userNameAr: text("user_name_ar").notNull().default(""),
    action: text("action").notNull(),
    actionAr: text("action_ar").notNull().default(""),
    target: text("target").notNull(),
    targetAr: text("target_ar").notNull().default(""),
    details: text("details"),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_logs_created_idx").on(table.createdAt),
    index("audit_logs_facility_created_idx").on(
      table.facilityId,
      table.createdAt,
    ),
    // Historical system-admin rows can remain unknown after the safe 0004
    // backfill. PostgreSQL adds this CHECK as NOT VALID in that migration, so
    // it still rejects NULL for every new event without falsifying history.
    check(
      "audit_logs_facility_required_for_new",
      sql`${table.facilityId} is not null`,
    ),
  ],
);

export const insertAuditLogSchema = createInsertSchema(auditLogsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLogRow = typeof auditLogsTable.$inferSelect;
