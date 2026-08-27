ALTER TABLE "upload_grants" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD COLUMN "processing_token" text;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD COLUMN "processing_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD COLUMN "processed_sha256" text;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD CONSTRAINT "upload_grants_processing_lifecycle_check" CHECK ((
        ("upload_grants"."status" = 'pending'
          AND "upload_grants"."processing_token" IS NULL
          AND "upload_grants"."processing_started_at" IS NULL
          AND "upload_grants"."processed_at" IS NULL
          AND "upload_grants"."processed_sha256" IS NULL)
        OR
        ("upload_grants"."status" = 'processing'
          AND "upload_grants"."processing_token" IS NOT NULL
          AND "upload_grants"."processing_started_at" IS NOT NULL
          AND "upload_grants"."processed_at" IS NULL
          AND "upload_grants"."processed_sha256" IS NULL)
        OR
        ("upload_grants"."status" = 'processed'
          AND "upload_grants"."processing_token" IS NULL
          AND "upload_grants"."processing_started_at" IS NOT NULL
          AND "upload_grants"."processed_at" IS NOT NULL
          AND "upload_grants"."processed_sha256" ~ '^[0-9a-f]{64}$')
      ));