-- SMS activation has been replaced by server-bound email OTP. Invalidate every
-- unconsumed Twilio challenge so no code approved under the retired flow can
-- be replayed after this release. Consumed history remains intact for audit.
UPDATE "phone_otp_challenges"
SET "status" = 'failed',
    "provider_verification_sid" = NULL,
    "dispatch_started_at" = NULL,
    "verification_started_at" = NULL,
    "verified_at" = NULL,
    "approval_proof_hash" = NULL,
    "consumed_at" = NULL,
    "updated_at" = now()
WHERE "status" <> 'consumed';--> statement-breakpoint
CREATE TABLE "email_otp_challenges" (
	"id" serial PRIMARY KEY NOT NULL,
	"invitation_id" integer NOT NULL,
	"status" text NOT NULL,
	"send_count" integer DEFAULT 0 NOT NULL,
	"send_window_started_at" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"dispatch_started_at" timestamp with time zone,
	"verification_started_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"next_send_at" timestamp with time zone NOT NULL,
	"code_salt" text,
	"code_hash" text,
	"verified_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_otp_challenges_status_valid" CHECK ("email_otp_challenges"."status" in ('preparing', 'dispatching', 'pending', 'verifying', 'approved', 'failed', 'consumed')),
	CONSTRAINT "email_otp_challenges_counts_valid" CHECK ("email_otp_challenges"."send_count" >= 0 and "email_otp_challenges"."attempt_count" >= 0),
	CONSTRAINT "email_otp_challenges_code_material_valid" CHECK ((("email_otp_challenges"."status" in ('dispatching', 'pending', 'verifying', 'approved')) and "email_otp_challenges"."code_salt" ~ '^[0-9a-f]{32}$' and "email_otp_challenges"."code_hash" ~ '^[0-9a-f]{64}$')
        or ("email_otp_challenges"."status" not in ('dispatching', 'pending', 'verifying', 'approved') and "email_otp_challenges"."code_salt" is null and "email_otp_challenges"."code_hash" is null)),
	CONSTRAINT "email_otp_challenges_terminal_state_valid" CHECK (("email_otp_challenges"."status" = 'approved' and "email_otp_challenges"."verified_at" is not null and "email_otp_challenges"."consumed_at" is null)
        or ("email_otp_challenges"."status" = 'consumed' and "email_otp_challenges"."verified_at" is not null and "email_otp_challenges"."consumed_at" is not null)
        or ("email_otp_challenges"."status" not in ('approved', 'consumed') and "email_otp_challenges"."verified_at" is null and "email_otp_challenges"."consumed_at" is null)),
	CONSTRAINT "email_otp_challenges_lease_state_valid" CHECK (("email_otp_challenges"."status" = 'dispatching' and "email_otp_challenges"."dispatch_started_at" is not null and "email_otp_challenges"."verification_started_at" is null)
        or ("email_otp_challenges"."status" = 'verifying' and "email_otp_challenges"."dispatch_started_at" is null and "email_otp_challenges"."verification_started_at" is not null)
        or ("email_otp_challenges"."status" not in ('dispatching', 'verifying') and "email_otp_challenges"."dispatch_started_at" is null and "email_otp_challenges"."verification_started_at" is null))
);
--> statement-breakpoint
ALTER TABLE "email_otp_challenges" ADD CONSTRAINT "email_otp_challenges_invitation_id_employee_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."employee_invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_otp_challenges_invitation_unique" ON "email_otp_challenges" USING btree ("invitation_id");--> statement-breakpoint
CREATE INDEX "email_otp_challenges_expiry_idx" ON "email_otp_challenges" USING btree ("expires_at");
