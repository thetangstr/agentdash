CREATE TABLE "bridge_staged_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"handle_id" uuid,
	"bridge_endpoint_id" uuid,
	"actor_user_id" text NOT NULL,
	"provider" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"original_filename" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attached_at" timestamp with time zone,
	"attachment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_attachments" ADD COLUMN "version_base_name" text;--> statement-breakpoint
ALTER TABLE "issue_attachments" ADD COLUMN "version" integer;--> statement-breakpoint
ALTER TABLE "bridge_staged_files" ADD CONSTRAINT "bridge_staged_files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_staged_files" ADD CONSTRAINT "bridge_staged_files_handle_id_steward_inbox_action_handles_id_fk" FOREIGN KEY ("handle_id") REFERENCES "public"."steward_inbox_action_handles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_staged_files" ADD CONSTRAINT "bridge_staged_files_bridge_endpoint_id_bridge_endpoints_id_fk" FOREIGN KEY ("bridge_endpoint_id") REFERENCES "public"."bridge_endpoints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_staged_files" ADD CONSTRAINT "bridge_staged_files_attachment_id_issue_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."issue_attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bridge_staged_files_handle_sha_uq" ON "bridge_staged_files" USING btree ("handle_id","sha256");--> statement-breakpoint
CREATE INDEX "bridge_staged_files_expiry_idx" ON "bridge_staged_files" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_attachments_version_uq" ON "issue_attachments" USING btree ("issue_id","version_base_name","version");