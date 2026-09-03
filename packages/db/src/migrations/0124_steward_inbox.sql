CREATE TABLE IF NOT EXISTS "steward_inbox_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"steward_user_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text NOT NULL,
	"agent_id" uuid,
	"dedupe_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "steward_inbox_sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"steward_user_id" text NOT NULL,
	"next_seq" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "steward_inbox_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"last_acked_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "steward_inbox_events" ADD CONSTRAINT "steward_inbox_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "steward_inbox_events" ADD CONSTRAINT "steward_inbox_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "steward_inbox_sequences" ADD CONSTRAINT "steward_inbox_sequences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "steward_inbox_cursors" ADD CONSTRAINT "steward_inbox_cursors_endpoint_id_bridge_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."bridge_endpoints"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "steward_inbox_events_stream_uq" ON "steward_inbox_events" USING btree ("company_id","steward_user_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "steward_inbox_events_dedupe_uq" ON "steward_inbox_events" USING btree ("company_id","dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "steward_inbox_events_ref_idx" ON "steward_inbox_events" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "steward_inbox_sequences_steward_uq" ON "steward_inbox_sequences" USING btree ("company_id","steward_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "steward_inbox_cursors_endpoint_uq" ON "steward_inbox_cursors" USING btree ("endpoint_id");
