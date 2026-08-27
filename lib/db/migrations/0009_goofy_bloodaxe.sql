CREATE TABLE "employee_invitations" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" integer NOT NULL,
	"facility_id" integer NOT NULL,
	"department_id" integer,
	"supervisor_id" integer,
	"name" text NOT NULL,
	"name_ar" text NOT NULL,
	"job_title" text NOT NULL,
	"job_title_ar" text NOT NULL,
	"employee_number" text NOT NULL,
	"phone" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_invitations_email_normalized" CHECK ("employee_invitations"."email" = lower("employee_invitations"."email") and "employee_invitations"."email" = btrim("employee_invitations"."email")),
	CONSTRAINT "employee_invitations_token_hash_format" CHECK ("employee_invitations"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "employee_invitations_terminal_state" CHECK (not ("employee_invitations"."accepted_at" is not null and "employee_invitations"."revoked_at" is not null)
        and (("employee_invitations"."accepted_at" is null and "employee_invitations"."accepted_user_id" is null)
          or ("employee_invitations"."accepted_at" is not null and "employee_invitations"."accepted_user_id" is not null))),
	CONSTRAINT "employee_invitations_expiry_after_creation" CHECK ("employee_invitations"."expires_at" > "employee_invitations"."created_at")
);
--> statement-breakpoint
ALTER TABLE "employee_invitations" ADD CONSTRAINT "employee_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_invitations" ADD CONSTRAINT "employee_invitations_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_invitations" ADD CONSTRAINT "employee_invitations_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_invitations" ADD CONSTRAINT "employee_invitations_supervisor_id_users_id_fk" FOREIGN KEY ("supervisor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_invitations" ADD CONSTRAINT "employee_invitations_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_invitations_token_hash_unique" ON "employee_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "employee_invitations_email_active_idx" ON "employee_invitations" USING btree ("email","accepted_at","revoked_at");--> statement-breakpoint
CREATE INDEX "employee_invitations_expiry_idx" ON "employee_invitations" USING btree ("expires_at");