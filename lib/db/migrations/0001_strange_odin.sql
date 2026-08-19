CREATE TABLE "upload_grants" (
	"id" serial PRIMARY KEY NOT NULL,
	"object_path" text NOT NULL,
	"requested_by" integer NOT NULL,
	"file_name" text NOT NULL,
	"declared_size" integer NOT NULL,
	"declared_content_type" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_grants_object_path_unique" UNIQUE("object_path")
);
--> statement-breakpoint
ALTER TABLE "upload_grants" ADD CONSTRAINT "upload_grants_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "upload_grants_requester_idx" ON "upload_grants" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX "upload_grants_expiry_idx" ON "upload_grants" USING btree ("expires_at");