CREATE TABLE IF NOT EXISTS "steward_inbox_action_handles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"company_id" uuid NOT NULL,
	"bridge_endpoint_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bridge_endpoints" ADD COLUMN IF NOT EXISTS "check_interval_minutes" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "steward_inbox_action_handles" ADD CONSTRAINT "steward_inbox_action_handles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "steward_inbox_action_handles" ADD CONSTRAINT "steward_inbox_action_handles_endpoint_id_bridge_endpoints_id_fk" FOREIGN KEY ("bridge_endpoint_id") REFERENCES "public"."bridge_endpoints"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "steward_inbox_action_handles_token_uq" ON "steward_inbox_action_handles" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "steward_inbox_action_handles_endpoint_idx" ON "steward_inbox_action_handles" USING btree ("bridge_endpoint_id");
