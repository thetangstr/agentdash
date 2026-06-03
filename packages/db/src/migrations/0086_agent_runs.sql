-- AgentDash (AGE-119): agent-run metering table.
-- One row per completed heartbeat run. Complexity tier (simple/medium/complex)
-- is derived at recording time from token count + duration. All tiers display
-- as a single "agent-run" unit. This table is the foundation for quota
-- enforcement (AGE-120), overage billing (AGE-122), and the ledger UX (AGE-123).

CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"heartbeat_run_id" uuid NOT NULL,
	"issue_id" uuid,
	"project_id" uuid,
	"complexity_tier" text DEFAULT 'simple' NOT NULL,
	"duration_ms" integer,
	"token_count" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_company_id_companies_id_fk"
	FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk"
	FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_heartbeat_run_id_heartbeat_runs_id_fk"
	FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_issue_id_issues_id_fk"
	FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_id_projects_id_fk"
	FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_heartbeat_run_id_unique"
	UNIQUE("heartbeat_run_id");
--> statement-breakpoint
CREATE INDEX "agent_runs_company_completed_idx" ON "agent_runs" USING btree ("company_id", "completed_at");
--> statement-breakpoint
CREATE INDEX "agent_runs_company_agent_completed_idx" ON "agent_runs" USING btree ("company_id", "agent_id", "completed_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_heartbeat_run_unique_idx" ON "agent_runs" USING btree ("heartbeat_run_id");
