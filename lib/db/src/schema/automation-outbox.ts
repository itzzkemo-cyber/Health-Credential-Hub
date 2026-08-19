import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { credentialsTable, type CredentialType } from "./credentials";
import { facilitiesTable } from "./facilities";

export const AUTOMATION_EVENT_TYPES = [
  "credential.created",
  "credential.verification_changed",
  "credential.expiry_due",
] as const;
export type AutomationEventType = (typeof AUTOMATION_EVENT_TYPES)[number];

export type AutomationEventData =
  | {
      credentialId: number;
      employeeId: number;
      credentialType: CredentialType;
    }
  | {
      credentialId: number;
      employeeId: number;
      credentialType: CredentialType;
      isVerified: boolean;
    }
  | {
      credentialId: number;
      employeeId: number;
      credentialType: CredentialType;
      expiryDate: string;
      dueInDays: number;
      thresholdDays: number;
    };

/**
 * Transactional outbox for optional workflow automation. Payloads are kept
 * deliberately small and must never contain document paths, QR tokens,
 * presigned URLs, OCR bodies, contact data, or authentication material.
 */
export const automationOutboxTable = pgTable(
  "automation_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    facilityId: integer("facility_id")
      .notNull()
      .references(() => facilitiesTable.id),
    credentialId: integer("credential_id")
      .notNull()
      .references(() => credentialsTable.id),
    eventType: text("event_type", { enum: AUTOMATION_EVENT_TYPES }).notNull(),
    deduplicationKey: text("deduplication_key").notNull(),
    payload: jsonb("payload").$type<AutomationEventData>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    discardedAt: timestamp("discarded_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("automation_outbox_dedupe_unique").on(table.deduplicationKey),
    index("automation_outbox_pending_idx")
      .on(table.availableAt, table.createdAt)
      .where(
        sql`${table.processedAt} is null and ${table.discardedAt} is null`,
      ),
    index("automation_outbox_facility_created_idx").on(
      table.facilityId,
      table.createdAt,
    ),
    check(
      "automation_outbox_event_type_allowed",
      sql`${table.eventType} in ('credential.created', 'credential.verification_changed', 'credential.expiry_due')`,
    ),
    check(
      "automation_outbox_attempts_nonnegative",
      sql`${table.attempts} >= 0`,
    ),
  ],
);

export type AutomationOutboxRow = typeof automationOutboxTable.$inferSelect;

export const AUTOMATION_DELIVERY_STATUSES = ["delivered", "discarded"] as const;
export type AutomationDeliveryStatus =
  (typeof AUTOMATION_DELIVERY_STATUSES)[number];

/**
 * Append-only disclosure ledger. Unlike processed outbox rows, these minimal
 * terminal records are not removed by worker retention cleanup.
 */
export const automationDeliveryLogTable = pgTable(
  "automation_delivery_log",
  {
    eventId: uuid("event_id").primaryKey(),
    facilityId: integer("facility_id")
      .notNull()
      .references(() => facilitiesTable.id),
    eventType: text("event_type", { enum: AUTOMATION_EVENT_TYPES }).notNull(),
    status: text("status", { enum: AUTOMATION_DELIVERY_STATUSES }).notNull(),
    attempts: integer("attempts").notNull(),
    lastErrorCode: text("last_error_code"),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("automation_delivery_log_facility_recorded_idx").on(
      table.facilityId,
      table.recordedAt,
    ),
    check(
      "automation_delivery_log_event_type_allowed",
      sql`${table.eventType} in ('credential.created', 'credential.verification_changed', 'credential.expiry_due')`,
    ),
    check(
      "automation_delivery_log_status_allowed",
      sql`${table.status} in ('delivered', 'discarded')`,
    ),
    check(
      "automation_delivery_log_attempts_nonnegative",
      sql`${table.attempts} >= 0`,
    ),
  ],
);

export type AutomationDeliveryLogRow =
  typeof automationDeliveryLogTable.$inferSelect;
