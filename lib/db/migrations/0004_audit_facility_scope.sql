ALTER TABLE "audit_logs" ADD COLUMN "facility_id" integer;--> statement-breakpoint
UPDATE "audit_logs"
SET "facility_id" = "users"."facility_id"
FROM "users"
WHERE "audit_logs"."user_id" = "users"."id"
  AND "users"."role" <> 'system_admin';--> statement-breakpoint
-- Historical system-administrator events cannot be assigned to the actor's
-- home facility safely: the affected tenant was not persisted. Keep those
-- rows NULL (visible only to global system administrators) while enforcing a
-- tenant on every new audit event until operators complete a reviewed backfill.
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_facility_required_for_new" CHECK ("audit_logs"."facility_id" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_facility_created_idx" ON "audit_logs" USING btree ("facility_id","created_at");
