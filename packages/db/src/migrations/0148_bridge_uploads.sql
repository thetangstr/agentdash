-- AgentDash (document access, slice 8): a person's own upload from their own
-- machine to their own OneDrive. The Graph upload URL is a bearer capability,
-- so it is stored encrypted and never returned; rows are purged after 7 days.
CREATE TABLE "bridge_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bridge_endpoint_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"connection_id" uuid,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"destination" jsonb NOT NULL,
	"sharing" jsonb NOT NULL,
	"upload_url_encrypted" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"drive_id" text,
	"item_id" text,
	"web_url" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "bridge_uploads_status_ck" CHECK ("bridge_uploads"."status" in ('open', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "bridge_uploads" ADD CONSTRAINT "bridge_uploads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_uploads" ADD CONSTRAINT "bridge_uploads_bridge_endpoint_id_bridge_endpoints_id_fk" FOREIGN KEY ("bridge_endpoint_id") REFERENCES "public"."bridge_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_uploads" ADD CONSTRAINT "bridge_uploads_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bridge_uploads_endpoint_idx" ON "bridge_uploads" USING btree ("bridge_endpoint_id","status");--> statement-breakpoint
CREATE INDEX "bridge_uploads_created_idx" ON "bridge_uploads" USING btree ("created_at");