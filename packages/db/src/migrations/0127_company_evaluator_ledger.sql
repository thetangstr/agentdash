CREATE TABLE "evaluation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"goal_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"source_table" text NOT NULL,
	"source_id" text NOT NULL,
	"source_version" text NOT NULL,
	"source_row_hash" text,
	"event_type" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"ingest_time" timestamp with time zone DEFAULT now() NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"correlation_id" text
);
--> statement-breakpoint
CREATE TABLE "evaluation_ingest_state" (
	"company_id" uuid NOT NULL,
	"source" text NOT NULL,
	"cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_ingest_state_company_id_source_pk" PRIMARY KEY("company_id","source")
);
--> statement-breakpoint
CREATE TABLE "evaluation_scorecards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"milestone_kind" text NOT NULL,
	"milestone_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"contract_version" text NOT NULL,
	"formula_version" text NOT NULL,
	"through_seq" bigint NOT NULL,
	"through_event_id" uuid,
	"card" jsonb NOT NULL,
	"card_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD COLUMN "principal_kind" text;--> statement-breakpoint
ALTER TABLE "evaluation_events" ADD CONSTRAINT "evaluation_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_ingest_state" ADD CONSTRAINT "evaluation_ingest_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_scorecards" ADD CONSTRAINT "evaluation_scorecards_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_events_dedupe_uq" ON "evaluation_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_events_seq_uq" ON "evaluation_events" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "evaluation_events_company_seq_idx" ON "evaluation_events" USING btree ("company_id","seq");--> statement-breakpoint
CREATE INDEX "evaluation_events_company_time_idx" ON "evaluation_events" USING btree ("company_id","event_time");--> statement-breakpoint
CREATE INDEX "evaluation_events_company_type_idx" ON "evaluation_events" USING btree ("company_id","event_type");--> statement-breakpoint
CREATE INDEX "evaluation_events_company_project_idx" ON "evaluation_events" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "evaluation_events_source_idx" ON "evaluation_events" USING btree ("company_id","source_table","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_scorecards_version_uq" ON "evaluation_scorecards" USING btree ("company_id","milestone_kind","milestone_id","version");--> statement-breakpoint
-- AgentDash (Company Evaluator, spec §10.2/§11): the ledger is append-only at
-- the row level. UPDATE is always refused. DELETE is refused unless the session
-- has set agentdash.ledger_purge = 'on', which only the company-deletion
-- transaction does (server/src/services/companies.ts remove()). TRUNCATE is
-- deliberately not trapped: it is a privilege-gated maintenance statement with
-- no application path, and the test harness truncates companies CASCADE.
-- Corrections are new rows.
CREATE OR REPLACE FUNCTION evaluation_events_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'evaluation_events is append-only: UPDATE refused' USING ERRCODE = 'restrict_violation';
  END IF;
  IF current_setting('agentdash.ledger_purge', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'evaluation_events is append-only: DELETE refused (set agentdash.ledger_purge for tenant deletion)' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER evaluation_events_immutable_trg
  BEFORE UPDATE OR DELETE ON "evaluation_events"
  FOR EACH ROW EXECUTE FUNCTION evaluation_events_immutable();
