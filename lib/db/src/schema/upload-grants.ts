import {
  check,
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

export const UPLOAD_GRANT_STATUSES = [
  "pending",
  "processing",
  "processed",
] as const;
export type UploadGrantStatus = (typeof UPLOAD_GRANT_STATUSES)[number];

/**
 * A short-lived, server-issued capability for one private object upload.
 *
 * The grant binds an opaque object path to its requester and records the
 * server-mediated processing lifecycle across multiple API instances.
 */
export const uploadGrantsTable = pgTable(
  "upload_grants",
  {
    id: serial("id").primaryKey(),
    objectPath: text("object_path").notNull().unique(),
    requestedBy: integer("requested_by")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    declaredSize: integer("declared_size").notNull(),
    declaredContentType: text("declared_content_type").notNull(),
    status: text("status")
      .$type<UploadGrantStatus>()
      .notNull()
      .default("pending"),
    processingToken: text("processing_token"),
    processingStartedAt: timestamp("processing_started_at", {
      withTimezone: true,
    }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    processedSha256: text("processed_sha256"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("upload_grants_requester_idx").on(table.requestedBy),
    index("upload_grants_expiry_idx").on(table.expiresAt),
    check(
      "upload_grants_processing_lifecycle_check",
      sql`(
        (${table.status} = 'pending'
          AND ${table.processingToken} IS NULL
          AND ${table.processingStartedAt} IS NULL
          AND ${table.processedAt} IS NULL
          AND ${table.processedSha256} IS NULL)
        OR
        (${table.status} = 'processing'
          AND ${table.processingToken} IS NOT NULL
          AND ${table.processingStartedAt} IS NOT NULL
          AND ${table.processedAt} IS NULL
          AND ${table.processedSha256} IS NULL)
        OR
        (${table.status} = 'processed'
          AND ${table.processingToken} IS NULL
          AND ${table.processingStartedAt} IS NOT NULL
          AND ${table.processedAt} IS NOT NULL
          AND ${table.processedSha256} ~ '^[0-9a-f]{64}$')
      )`,
    ),
  ],
);

export type UploadGrant = typeof uploadGrantsTable.$inferSelect;
