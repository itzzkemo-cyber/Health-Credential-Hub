ALTER TABLE "phone_otp_challenges" DROP CONSTRAINT "phone_otp_challenges_status_valid";--> statement-breakpoint
ALTER TABLE "phone_otp_challenges" DROP CONSTRAINT "phone_otp_challenges_terminal_state_valid";--> statement-breakpoint
ALTER TABLE "phone_otp_challenges" ADD COLUMN "dispatch_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "phone_otp_challenges" ADD COLUMN "approval_proof_hash" text;--> statement-breakpoint
UPDATE "phone_otp_challenges"
SET "status" = 'failed',
    "dispatch_started_at" = NULL,
    "verification_started_at" = NULL,
    "verified_at" = NULL,
    "approval_proof_hash" = NULL,
    "consumed_at" = NULL,
    "updated_at" = now()
WHERE "status" = 'dispatching'
   OR ("status" = 'verifying' AND "verification_started_at" IS NULL);--> statement-breakpoint
UPDATE "phone_otp_challenges"
SET "verification_started_at" = CASE
      WHEN "status" = 'verifying' THEN "verification_started_at"
      ELSE NULL
    END,
    "verified_at" = NULL,
    "approval_proof_hash" = NULL,
    "updated_at" = now()
WHERE "status" <> 'consumed';--> statement-breakpoint
ALTER TABLE "phone_otp_challenges" ADD CONSTRAINT "phone_otp_challenges_lease_state_valid" CHECK (("phone_otp_challenges"."status" = 'dispatching' and "phone_otp_challenges"."dispatch_started_at" is not null and "phone_otp_challenges"."verification_started_at" is null)
        or ("phone_otp_challenges"."status" = 'verifying' and "phone_otp_challenges"."dispatch_started_at" is null and "phone_otp_challenges"."verification_started_at" is not null)
        or ("phone_otp_challenges"."status" not in ('dispatching', 'verifying') and "phone_otp_challenges"."dispatch_started_at" is null and "phone_otp_challenges"."verification_started_at" is null));--> statement-breakpoint
ALTER TABLE "phone_otp_challenges" ADD CONSTRAINT "phone_otp_challenges_status_valid" CHECK ("phone_otp_challenges"."status" in ('dispatching', 'pending', 'verifying', 'approved', 'failed', 'consumed'));--> statement-breakpoint
ALTER TABLE "phone_otp_challenges" ADD CONSTRAINT "phone_otp_challenges_terminal_state_valid" CHECK (("phone_otp_challenges"."status" = 'approved' and "phone_otp_challenges"."verified_at" is not null and "phone_otp_challenges"."approval_proof_hash" is not null and "phone_otp_challenges"."consumed_at" is null)
        or ("phone_otp_challenges"."status" = 'consumed' and "phone_otp_challenges"."verified_at" is not null and "phone_otp_challenges"."approval_proof_hash" is null and "phone_otp_challenges"."consumed_at" is not null)
        or ("phone_otp_challenges"."status" not in ('approved', 'consumed') and "phone_otp_challenges"."verified_at" is null and "phone_otp_challenges"."approval_proof_hash" is null and "phone_otp_challenges"."consumed_at" is null));
