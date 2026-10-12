CREATE TABLE "agent_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_actor_type" text NOT NULL,
	"source_actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"delivered_run_id" uuid,
	"delivery_attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_corrections" ADD CONSTRAINT "agent_corrections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_corrections" ADD CONSTRAINT "agent_corrections_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_corrections" ADD CONSTRAINT "agent_corrections_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_corrections" ADD CONSTRAINT "agent_corrections_delivered_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("delivered_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_corrections_agent_idx" ON "agent_corrections" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_corrections_issue_idx" ON "agent_corrections" USING btree ("issue_id");