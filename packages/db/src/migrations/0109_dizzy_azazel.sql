CREATE TABLE "workflow_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pipeline_id" text NOT NULL,
	"run_id" text NOT NULL,
	"step_key" text NOT NULL,
	"event_type" text NOT NULL,
	"actor_kind" text NOT NULL,
	"duration_ms" integer,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_events_actor_kind_ck" CHECK ("workflow_events"."actor_kind" in ('human', 'agent', 'system')),
	CONSTRAINT "workflow_events_payload_object_ck" CHECK (jsonb_typeof("workflow_events"."payload") = 'object'),
	CONSTRAINT "workflow_events_payload_no_person_ck" CHECK ("workflow_events"."payload"::text !~* '"(user_?id|user_?ids|actor_?user_?id|assignee_?id|principal_?id|steward_?id|member_?id|agent_?id|agent_?ids|owner_?id|decided_?by[a-z_]*|requested_?by[a-z_]*|answered_?by[a-z_]*|approved_?by[a-z_]*|email)"')
);
--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_events_run_idx" ON "workflow_events" USING btree ("company_id","run_id","occurred_at");--> statement-breakpoint
CREATE INDEX "workflow_events_pipeline_idx" ON "workflow_events" USING btree ("company_id","pipeline_id","occurred_at");