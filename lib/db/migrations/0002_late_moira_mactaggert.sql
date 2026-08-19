ALTER TABLE "credentials" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "deleted_by" integer;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credentials_deleted_at_idx" ON "credentials" USING btree ("deleted_at");