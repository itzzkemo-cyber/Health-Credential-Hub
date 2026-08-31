ALTER TABLE "shift_schedules" DROP CONSTRAINT "shift_schedules_status_valid";--> statement-breakpoint
DROP INDEX "shift_schedule_members_employee_month_uidx";--> statement-breakpoint
ALTER TABLE "shift_schedule_members" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "shift_schedule_members_employee_month_uidx" ON "shift_schedule_members" USING btree ("employee_id","month") WHERE "shift_schedule_members"."released_at" is null;--> statement-breakpoint
ALTER TABLE "shift_schedules" ADD CONSTRAINT "shift_schedules_status_valid" CHECK ("shift_schedules"."status" in ('draft', 'published', 'cancelled'));