CREATE TABLE "agent_fact_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pipeline_id" text NOT NULL,
	"run_id" text NOT NULL,
	"fact_key" text NOT NULL,
	"question" text NOT NULL,
	"requested_by_agent_id" uuid NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"status" text DEFAULT 'asked' NOT NULL,
	"answer" text,
	"answer_source_kind" text,
	"answered_by_agent_id" uuid,
	"answered_at" timestamp with time zone,
	"decline_reason" text,
	"escalated_at" timestamp with time zone,
	"escalation_task_id" uuid,
	"harness_reachable" boolean,
	"lease_expires_at" timestamp with time zone,
	"flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_fact_requests_status_ck" CHECK ("agent_fact_requests"."status" in ('asked', 'answered', 'declined', 'escalated', 'missing')),
	CONSTRAINT "agent_fact_requests_source_kind_ck" CHECK ("agent_fact_requests"."answer_source_kind" is null or "agent_fact_requests"."answer_source_kind" in ('connector', 'harness', 'human', 'agent', 'external')),
	CONSTRAINT "agent_fact_requests_not_self_ck" CHECK ("agent_fact_requests"."requested_by_agent_id" <> "agent_fact_requests"."target_agent_id"),
	CONSTRAINT "agent_fact_requests_answer_framed_ck" CHECK ("agent_fact_requests"."answer" is null or "agent_fact_requests"."answer" like '<untrusted-agent-answer>%')
);
--> statement-breakpoint
ALTER TABLE "agent_fact_requests" ADD CONSTRAINT "agent_fact_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_fact_requests" ADD CONSTRAINT "agent_fact_requests_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_fact_requests" ADD CONSTRAINT "agent_fact_requests_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_fact_requests" ADD CONSTRAINT "agent_fact_requests_answered_by_agent_id_agents_id_fk" FOREIGN KEY ("answered_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_fact_requests" ADD CONSTRAINT "agent_fact_requests_escalation_task_id_bridge_tasks_id_fk" FOREIGN KEY ("escalation_task_id") REFERENCES "public"."bridge_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_fact_requests_run_fact_uq" ON "agent_fact_requests" USING btree ("company_id","run_id","fact_key");--> statement-breakpoint
CREATE INDEX "agent_fact_requests_target_idx" ON "agent_fact_requests" USING btree ("company_id","target_agent_id","status");--> statement-breakpoint
CREATE INDEX "agent_fact_requests_requester_idx" ON "agent_fact_requests" USING btree ("company_id","requested_by_agent_id","status");--> statement-breakpoint
CREATE INDEX "agent_fact_requests_lease_idx" ON "agent_fact_requests" USING btree ("status","lease_expires_at");