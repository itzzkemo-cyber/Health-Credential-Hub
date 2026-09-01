CREATE TABLE "schedule_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"facility_id" integer NOT NULL,
	"kind" text NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"shift_code" text,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"feasibility_status" text DEFAULT 'unknown' NOT NULL,
	"feasibility_reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evaluated_schedule_id" integer,
	"evaluated_schedule_version" integer,
	"evaluated_at" timestamp with time zone NOT NULL,
	"decided_by" integer,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_requests_kind_valid" CHECK ("schedule_requests"."kind" in ('leave', 'preferred_shift', 'off', 'eo')),
	CONSTRAINT "schedule_requests_status_valid" CHECK ("schedule_requests"."status" in ('pending', 'approved', 'rejected', 'withdrawn')),
	CONSTRAINT "schedule_requests_feasibility_valid" CHECK ("schedule_requests"."feasibility_status" in ('possible', 'conflict', 'unknown')),
	CONSTRAINT "schedule_requests_start_date_format" CHECK ("schedule_requests"."start_date" ~ '^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
	CONSTRAINT "schedule_requests_end_date_format" CHECK ("schedule_requests"."end_date" ~ '^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
	CONSTRAINT "schedule_requests_date_order" CHECK ("schedule_requests"."end_date" >= "schedule_requests"."start_date"),
	CONSTRAINT "schedule_requests_single_month" CHECK (left("schedule_requests"."start_date", 7) = left("schedule_requests"."end_date", 7)),
	CONSTRAINT "schedule_requests_kind_shape" CHECK (("schedule_requests"."kind" = 'leave' or "schedule_requests"."start_date" = "schedule_requests"."end_date") and (("schedule_requests"."kind" = 'preferred_shift' and "schedule_requests"."shift_code" ~ '^[A-Z][A-Z0-9_-]{0,7}$') or ("schedule_requests"."kind" <> 'preferred_shift' and "schedule_requests"."shift_code" is null))),
	CONSTRAINT "schedule_requests_note_length" CHECK ("schedule_requests"."note" is null or char_length("schedule_requests"."note") between 1 and 500),
	CONSTRAINT "schedule_requests_version_positive" CHECK ("schedule_requests"."row_version" >= 1),
	CONSTRAINT "schedule_requests_feasibility_reasons_array" CHECK (jsonb_typeof("schedule_requests"."feasibility_reason_codes") = 'array' and jsonb_array_length("schedule_requests"."feasibility_reason_codes") <= 20),
	CONSTRAINT "schedule_requests_schedule_snapshot_complete" CHECK (("schedule_requests"."evaluated_schedule_id" is null and "schedule_requests"."evaluated_schedule_version" is null) or ("schedule_requests"."evaluated_schedule_id" is not null and "schedule_requests"."evaluated_schedule_version" >= 1)),
	CONSTRAINT "schedule_requests_decision_shape" CHECK (("schedule_requests"."status" in ('approved', 'rejected') and "schedule_requests"."decided_by" is not null and "schedule_requests"."decided_at" is not null) or ("schedule_requests"."status" in ('pending', 'withdrawn') and "schedule_requests"."decided_by" is null and "schedule_requests"."decided_at" is null))
);
--> statement-breakpoint
ALTER TABLE "schedule_requests" ADD CONSTRAINT "schedule_requests_employee_id_users_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_requests" ADD CONSTRAINT "schedule_requests_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_requests" ADD CONSTRAINT "schedule_requests_evaluated_schedule_id_shift_schedules_id_fk" FOREIGN KEY ("evaluated_schedule_id") REFERENCES "public"."shift_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_requests" ADD CONSTRAINT "schedule_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_requests_employee_created_idx" ON "schedule_requests" USING btree ("employee_id","created_at");--> statement-breakpoint
CREATE INDEX "schedule_requests_facility_status_created_idx" ON "schedule_requests" USING btree ("facility_id","status","created_at");--> statement-breakpoint
CREATE INDEX "schedule_requests_schedule_idx" ON "schedule_requests" USING btree ("evaluated_schedule_id");