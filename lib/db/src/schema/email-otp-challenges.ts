import { sql } from "drizzle-orm";
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
import { employeeInvitationsTable } from "./employee-invitations";

/**
 * Durable email OTP state for an administrator-issued employee invitation.
 *
 * Only a random salt and a secret-keyed HMAC are stored. The six-digit code,
 * invitation token, and invitation email never appear in this table. The row
 * provides cluster-wide cooldowns, budgets, expiry, dispatch leases, and
 * single-use state.
 */
export const emailOtpChallengesTable = pgTable(
  "email_otp_challenges",
  {
    id: serial("id").primaryKey(),
    invitationId: integer("invitation_id")
      .notNull()
      .references(() => employeeInvitationsTable.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    sendCount: integer("send_count").notNull().default(0),
    sendWindowStartedAt: timestamp("send_window_started_at", {
      withTimezone: true,
    }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    dispatchStartedAt: timestamp("dispatch_started_at", {
      withTimezone: true,
    }),
    verificationStartedAt: timestamp("verification_started_at", {
      withTimezone: true,
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    nextSendAt: timestamp("next_send_at", { withTimezone: true }).notNull(),
    codeSalt: text("code_salt"),
    codeHash: text("code_hash"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("email_otp_challenges_invitation_unique").on(
      table.invitationId,
    ),
    index("email_otp_challenges_expiry_idx").on(table.expiresAt),
    check(
      "email_otp_challenges_status_valid",
      sql`${table.status} in ('preparing', 'dispatching', 'pending', 'verifying', 'approved', 'failed', 'consumed')`,
    ),
    check(
      "email_otp_challenges_counts_valid",
      sql`${table.sendCount} >= 0 and ${table.attemptCount} >= 0`,
    ),
    check(
      "email_otp_challenges_code_material_valid",
      sql`((${table.status} in ('dispatching', 'pending', 'verifying', 'approved')) and ${table.codeSalt} ~ '^[0-9a-f]{32}$' and ${table.codeHash} ~ '^[0-9a-f]{64}$')
        or (${table.status} not in ('dispatching', 'pending', 'verifying', 'approved') and ${table.codeSalt} is null and ${table.codeHash} is null)`,
    ),
    check(
      "email_otp_challenges_terminal_state_valid",
      sql`(${table.status} = 'approved' and ${table.verifiedAt} is not null and ${table.consumedAt} is null)
        or (${table.status} = 'consumed' and ${table.verifiedAt} is not null and ${table.consumedAt} is not null)
        or (${table.status} not in ('approved', 'consumed') and ${table.verifiedAt} is null and ${table.consumedAt} is null)`,
    ),
    check(
      "email_otp_challenges_lease_state_valid",
      sql`(${table.status} = 'dispatching' and ${table.dispatchStartedAt} is not null and ${table.verificationStartedAt} is null)
        or (${table.status} = 'verifying' and ${table.dispatchStartedAt} is null and ${table.verificationStartedAt} is not null)
        or (${table.status} not in ('dispatching', 'verifying') and ${table.dispatchStartedAt} is null and ${table.verificationStartedAt} is null)`,
    ),
  ],
);

export type EmailOtpChallenge = typeof emailOtpChallengesTable.$inferSelect;
