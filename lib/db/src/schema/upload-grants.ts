import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * A short-lived, server-issued capability for one private object upload.
 *
 * Object storage upload URLs are intentionally direct-to-storage. Keeping the
 * grant in PostgreSQL binds the resulting opaque object path to the user who
 * requested it, even when the API runs on more than one instance.
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
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("upload_grants_requester_idx").on(table.requestedBy),
    index("upload_grants_expiry_idx").on(table.expiresAt),
  ],
);

export type UploadGrant = typeof uploadGrantsTable.$inferSelect;
