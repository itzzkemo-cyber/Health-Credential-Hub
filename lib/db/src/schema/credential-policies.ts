import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const credentialPoliciesTable = pgTable("credential_policies", {
  id: serial("id").primaryKey(),
  facilityId: integer("facility_id").notNull(),
  credentialType: text("credential_type").notNull(),
  departmentId: integer("department_id"),
  roles: jsonb("roles").$type<string[]>().notNull().default([]),
  isRequired: boolean("is_required").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertCredentialPolicySchema = createInsertSchema(
  credentialPoliciesTable,
).omit({ id: true, createdAt: true });
export type InsertCredentialPolicy = z.infer<
  typeof insertCredentialPolicySchema
>;
export type CredentialPolicyRow = typeof credentialPoliciesTable.$inferSelect;
