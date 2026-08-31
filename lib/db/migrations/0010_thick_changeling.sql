CREATE TABLE "shift_schedule_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"schedule_id" integer NOT NULL,
	"employee_id" integer NOT NULL,
	"month" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_id" integer NOT NULL,
	"title" text NOT NULL,
	"month" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"configuration" jsonb NOT NULL,
	"assignments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" integer NOT NULL,
	"updated_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_schedules_month_format" CHECK ("shift_schedules"."month" ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "shift_schedules_status_valid" CHECK ("shift_schedules"."status" in ('draft', 'published')),
	CONSTRAINT "shift_schedules_version_positive" CHECK ("shift_schedules"."row_version" >= 1),
	CONSTRAINT "shift_schedules_title_length" CHECK (char_length("shift_schedules"."title") between 1 and 120),
	CONSTRAINT "shift_schedules_configuration_object" CHECK (jsonb_typeof("shift_schedules"."configuration") = 'object'),
	CONSTRAINT "shift_schedules_assignments_array" CHECK (jsonb_typeof("shift_schedules"."assignments") = 'array' and jsonb_array_length("shift_schedules"."assignments") <= 6200)
);
--> statement-breakpoint
ALTER TABLE "shift_schedule_members" ADD CONSTRAINT "shift_schedule_members_employee_id_users_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_schedules" ADD CONSTRAINT "shift_schedules_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_schedules" ADD CONSTRAINT "shift_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_schedules" ADD CONSTRAINT "shift_schedules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shift_schedule_members_employee_month_uidx" ON "shift_schedule_members" USING btree ("employee_id","month");--> statement-breakpoint
CREATE INDEX "shift_schedule_members_schedule_idx" ON "shift_schedule_members" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "shift_schedules_facility_month_idx" ON "shift_schedules" USING btree ("facility_id","month");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_schedules_id_month_uidx" ON "shift_schedules" USING btree ("id","month");--> statement-breakpoint
-- The referenced unique index must exist before this composite foreign key.
ALTER TABLE "shift_schedule_members" ADD CONSTRAINT "shift_schedule_members_schedule_month_fk" FOREIGN KEY ("schedule_id","month") REFERENCES "public"."shift_schedules"("id","month") ON DELETE no action ON UPDATE no action;
