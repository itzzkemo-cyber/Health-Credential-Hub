import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  jsonb,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const CREDENTIAL_TYPES = [
  "BLS",
  "ACLS",
  "PALS",
  "NRP",
  "TNCC",
  "TCRN",
  "code_red",
  "code_blue",
  "fire_safety",
  "infection_control",
  "SCFHS_license",
  "SCFHS_classification",
  "malpractice_insurance",
  "employment_id",
  "passport",
  "iqama",
  "visa",
  "driving_license",
  "medical_license",
  "custom",
] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export const credentialsTable = pgTable(
  "credentials",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => usersTable.id),
    type: text("type", { enum: CREDENTIAL_TYPES }).notNull(),
    customTypeName: text("custom_type_name"),
    customTypeNameAr: text("custom_type_name_ar"),
    holderName: text("holder_name").notNull(),
    holderNameAr: text("holder_name_ar").notNull(),
    issuerName: text("issuer_name").notNull(),
    issuerNameAr: text("issuer_name_ar").notNull(),
    certificateNumber: text("certificate_number").notNull(),
    issueDate: text("issue_date").notNull(),
    expiryDate: text("expiry_date").notNull(),
    fileUrl: text("file_url"),
    fileType: text("file_type"),
    qrToken: text("qr_token").notNull().unique(),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    notes: text("notes"),
    confidence: real("confidence"),
    isVerified: boolean("is_verified").notNull().default(false),
    rowVersion: integer("row_version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: integer("deleted_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("credentials_employee_idx").on(table.employeeId),
    index("credentials_expiry_idx").on(table.expiryDate),
    index("credentials_deleted_at_idx").on(table.deletedAt),
    uniqueIndex("credentials_active_file_url_unique")
      .on(table.fileUrl)
      .where(sql`${table.deletedAt} is null and ${table.fileUrl} is not null`),
  ],
);

export const insertCredentialSchema = createInsertSchema(
  credentialsTable,
).omit({
  id: true,
  rowVersion: true,
  deletedAt: true,
  deletedBy: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCredential = z.infer<typeof insertCredentialSchema>;
export type CredentialRow = typeof credentialsTable.$inferSelect;
