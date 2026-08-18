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
} from "drizzle-orm/pg-core";
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
  ],
);

export const insertCredentialSchema = createInsertSchema(
  credentialsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCredential = z.infer<typeof insertCredentialSchema>;
export type CredentialRow = typeof credentialsTable.$inferSelect;
