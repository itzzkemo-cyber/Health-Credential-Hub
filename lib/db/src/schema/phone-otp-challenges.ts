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
 * Durable SMS verification state for an employee invitation.
 *
 * OTP values are generated and retained by the configured verification
 * provider and are never persisted here. The row provides cluster-wide send
 * cooldowns, attempt budgets, expiry, concurrency leases, and replay state.
 */
export const phoneOtpChallengesTable = pgTable(
  "phone_otp_challenges",
  {
    id: serial("id").primaryKey(),
    invitationId: integer("invitation_id")
      .notNull()
      .references(() => employeeInvitationsTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerVerificationSid: text("provider_verification_sid"),
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
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    approvalProofHash: text("approval_proof_hash"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("phone_otp_challenges_invitation_unique").on(
      table.invitationId,
    ),
    index("phone_otp_challenges_expiry_idx").on(table.expiresAt),
    check(
      "phone_otp_challenges_status_valid",
      sql`${table.status} in ('dispatching', 'pending', 'verifying', 'approved', 'failed', 'consumed')`,
    ),
    check(
      "phone_otp_challenges_counts_valid",
      sql`${table.sendCount} >= 0 and ${table.attemptCount} >= 0`,
    ),
    check(
      "phone_otp_challenges_approval_proof_valid",
      sql`${table.approvalProofHash} is null or ${table.approvalProofHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "phone_otp_challenges_provider_verification_sid_valid",
      sql`${table.providerVerificationSid} is null or ${table.providerVerificationSid} ~ '^VE[0-9a-fA-F]{32}$'`,
    ),
    check(
      "phone_otp_challenges_provider_state_valid",
      sql`(${table.status} in ('pending', 'verifying', 'approved') and ${table.providerVerificationSid} is not null)
        or (${table.status} not in ('pending', 'verifying', 'approved') and ${table.providerVerificationSid} is null)`,
    ),
    check(
      "phone_otp_challenges_terminal_state_valid",
      sql`(${table.status} = 'approved' and ${table.verifiedAt} is not null and ${table.approvalProofHash} is not null and ${table.consumedAt} is null)
        or (${table.status} = 'consumed' and ${table.verifiedAt} is not null and ${table.approvalProofHash} is null and ${table.consumedAt} is not null)
        or (${table.status} not in ('approved', 'consumed') and ${table.verifiedAt} is null and ${table.approvalProofHash} is null and ${table.consumedAt} is null)`,
    ),
    check(
      "phone_otp_challenges_lease_state_valid",
      sql`(${table.status} = 'dispatching' and ${table.dispatchStartedAt} is not null and ${table.verificationStartedAt} is null)
        or (${table.status} = 'verifying' and ${table.dispatchStartedAt} is null and ${table.verificationStartedAt} is not null)
        or (${table.status} not in ('dispatching', 'verifying') and ${table.dispatchStartedAt} is null and ${table.verificationStartedAt} is null)`,
    ),
  ],
);

export type PhoneOtpChallenge = typeof phoneOtpChallengesTable.$inferSelect;
