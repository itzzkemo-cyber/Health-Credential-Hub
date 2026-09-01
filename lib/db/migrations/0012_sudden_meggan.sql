CREATE TABLE "phone_otp_challenges" (
	"id" serial PRIMARY KEY NOT NULL,
	"invitation_id" integer NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"send_count" integer DEFAULT 0 NOT NULL,
	"send_window_started_at" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"verification_started_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"next_send_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_otp_challenges_status_valid" CHECK ("phone_otp_challenges"."status" in ('dispatching', 'pending', 'verifying', 'failed', 'consumed')),
	CONSTRAINT "phone_otp_challenges_counts_valid" CHECK ("phone_otp_challenges"."send_count" >= 0 and "phone_otp_challenges"."attempt_count" >= 0),
	CONSTRAINT "phone_otp_challenges_terminal_state_valid" CHECK (("phone_otp_challenges"."status" = 'consumed' and "phone_otp_challenges"."verified_at" is not null and "phone_otp_challenges"."consumed_at" is not null)
        or ("phone_otp_challenges"."status" <> 'consumed' and "phone_otp_challenges"."consumed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "phone_otp_challenges" ADD CONSTRAINT "phone_otp_challenges_invitation_id_employee_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."employee_invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_otp_challenges_invitation_unique" ON "phone_otp_challenges" USING btree ("invitation_id");--> statement-breakpoint
CREATE INDEX "phone_otp_challenges_expiry_idx" ON "phone_otp_challenges" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_phone_verification_requires_phone" CHECK ("users"."phone_verified_at" is null or "users"."phone" is not null);