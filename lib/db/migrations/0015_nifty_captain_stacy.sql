ALTER TABLE "phone_otp_challenges" ADD COLUMN "provider_verification_sid" text;--> statement-breakpoint
-- Existing pre-SID challenges cannot be safely associated with a specific
-- Twilio Verification resource. Fail them closed so employees request a fresh
-- code after this migration instead of accepting an ambiguous provider check.
UPDATE "phone_otp_challenges"
SET "status" = 'failed',
    "dispatch_started_at" = NULL,
    "verification_started_at" = NULL,
    "verified_at" = NULL,
    "approval_proof_hash" = NULL,
    "consumed_at" = NULL,
    "updated_at" = now()
WHERE "status" IN ('pending', 'verifying', 'approved');--> statement-breakpoint
ALTER TABLE "phone_otp_challenges" ADD CONSTRAINT "phone_otp_challenges_provider_verification_sid_valid" CHECK ("phone_otp_challenges"."provider_verification_sid" is null or "phone_otp_challenges"."provider_verification_sid" ~ '^VE[0-9a-fA-F]{32}$');--> statement-breakpoint
ALTER TABLE "phone_otp_challenges" ADD CONSTRAINT "phone_otp_challenges_provider_state_valid" CHECK (("phone_otp_challenges"."status" in ('pending', 'verifying', 'approved') and "phone_otp_challenges"."provider_verification_sid" is not null)
        or ("phone_otp_challenges"."status" not in ('pending', 'verifying', 'approved') and "phone_otp_challenges"."provider_verification_sid" is null));
