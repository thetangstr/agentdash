-- AgentDash: Atlas Wire world-events newsroom (AGE-atlas-wire).
-- One row per logged world event. Deduped on (company_id, source_url_hash).
-- Authored by the beat agent. Clockchain receipt stored in receipt jsonb.

CREATE TABLE "news_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"beat" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"source_url" text NOT NULL,
	"source_url_hash" text NOT NULL,
	"source_outlet" text,
	"occurred_at" timestamp with time zone,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"clockchain_time" text,
	"event_hash" text NOT NULL,
	"ledger_id" text,
	"block_height" text,
	"clockchain_tool" text,
	"entities" jsonb,
	"geo" jsonb,
	"confidence" real,
	"inflection" jsonb,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "news_events" ADD CONSTRAINT "news_events_company_id_companies_id_fk"
	FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "news_events" ADD CONSTRAINT "news_events_agent_id_agents_id_fk"
	FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "news_events_company_ingested_idx" ON "news_events" USING btree ("company_id", "ingested_at");
--> statement-breakpoint
CREATE INDEX "news_events_company_beat_idx" ON "news_events" USING btree ("company_id", "beat");
--> statement-breakpoint
CREATE UNIQUE INDEX "news_events_company_source_hash_uq" ON "news_events" USING btree ("company_id", "source_url_hash");
