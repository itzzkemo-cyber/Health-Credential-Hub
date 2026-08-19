CREATE TABLE "automation_delivery_log" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"facility_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer NOT NULL,
	"last_error_code" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_delivery_log_event_type_allowed" CHECK ("automation_delivery_log"."event_type" in ('credential.created', 'credential.verification_changed', 'credential.expiry_due')),
	CONSTRAINT "automation_delivery_log_status_allowed" CHECK ("automation_delivery_log"."status" in ('delivered', 'discarded')),
	CONSTRAINT "automation_delivery_log_attempts_nonnegative" CHECK ("automation_delivery_log"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "automation_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" integer NOT NULL,
	"credential_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"deduplication_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"discarded_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_outbox_event_type_allowed" CHECK ("automation_outbox"."event_type" in ('credential.created', 'credential.verification_changed', 'credential.expiry_due')),
	CONSTRAINT "automation_outbox_attempts_nonnegative" CHECK ("automation_outbox"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "automation_delivery_log" ADD CONSTRAINT "automation_delivery_log_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_outbox" ADD CONSTRAINT "automation_outbox_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_outbox" ADD CONSTRAINT "automation_outbox_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_delivery_log_facility_recorded_idx" ON "automation_delivery_log" USING btree ("facility_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_outbox_dedupe_unique" ON "automation_outbox" USING btree ("deduplication_key");--> statement-breakpoint
CREATE INDEX "automation_outbox_pending_idx" ON "automation_outbox" USING btree ("available_at","created_at") WHERE "automation_outbox"."processed_at" is null and "automation_outbox"."discarded_at" is null;--> statement-breakpoint
CREATE INDEX "automation_outbox_facility_created_idx" ON "automation_outbox" USING btree ("facility_id","created_at");