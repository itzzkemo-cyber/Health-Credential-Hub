import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const NOTIFICATION_TYPES = [
  "expiry_warning",
  "expired",
  "new_credential",
  "system",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const notificationsTable = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    type: text("type", { enum: NOTIFICATION_TYPES }).notNull(),
    titleAr: text("title_ar").notNull(),
    titleEn: text("title_en").notNull(),
    messageAr: text("message_ar").notNull(),
    messageEn: text("message_en").notNull(),
    credentialId: integer("credential_id"),
    employeeId: integer("employee_id"),
    isRead: boolean("is_read").notNull().default(false),
    daysUntilExpiry: integer("days_until_expiry"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("notifications_user_idx").on(table.userId)],
);

export const insertNotificationSchema = createInsertSchema(
  notificationsTable,
).omit({ id: true, createdAt: true });
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type NotificationRow = typeof notificationsTable.$inferSelect;
