import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

export const EMAIL_KINDS = ["expiry_alert", "weekly_digest"] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

// `skipped` = deliberately suppressed (demo/test fixture recipient) — the
// attempt is consumed so fixtures are never retried, but it is not a failure.
export const EMAIL_STATUSES = ["sending", "sent", "failed", "skipped"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/**
 * One row per email attempt. Doubles as the idempotency ledger with
 * DB-level uniqueness so concurrent dispatchers (hourly scheduler,
 * on-activity trigger, multiple instances) can never double-send:
 *
 * - expiry alerts: unique on notification_id — a claim row (status
 *   `sending`) is inserted with ON CONFLICT DO NOTHING *before* sending;
 *   only the winner sends, then flips the row to `sent`/`failed`.
 *   One attempt per notification — failures stay recorded, no auto-retry.
 * - weekly digests: unique on (user_id, week_key) — at most one digest
 *   attempt per manager per week, claimed the same way.
 */
export const emailLogTable = pgTable(
  "email_log",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    notificationId: integer("notification_id"),
    kind: text("kind", { enum: EMAIL_KINDS }).notNull(),
    /** Riyadh-Sunday date (YYYY-MM-DD) for weekly digests; null otherwise. */
    weekKey: text("week_key"),
    recipient: text("recipient").notNull(),
    subject: text("subject").notNull(),
    status: text("status", { enum: EMAIL_STATUSES }).notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("email_log_user_idx").on(table.userId),
    uniqueIndex("email_log_notification_unique")
      .on(table.notificationId)
      .where(sql`notification_id is not null`),
    uniqueIndex("email_log_digest_week_unique")
      .on(table.userId, table.weekKey)
      .where(sql`kind = 'weekly_digest' and week_key is not null`),
  ],
);

export type EmailLogRow = typeof emailLogTable.$inferSelect;
