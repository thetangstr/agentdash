CREATE TABLE "evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"experiment_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"hypothesis_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"summary" text NOT NULL,
	"analysis" jsonb NOT NULL,
	"confidence_level" double precision,
	"cost_total_cents" integer,
	"next_action" text NOT NULL,
	"next_action_detail" jsonb,
	"evaluated_by_agent_id" uuid,
	"evaluated_by_user_id" text,
	"approved_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"hypothesis_id" uuid NOT NULL,
	"project_id" uuid,
	"issue_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'design' NOT NULL,
	"success_criteria" jsonb NOT NULL,
	"budget_cap_cents" integer,
	"budget_policy_id" uuid,
	"time_limit_hours" integer,
	"rollback_trigger" jsonb,
	"approval_id" uuid,
	"started_at" timestamp with time zone,
	"measuring_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"aborted_at" timestamp with time zone,
	"abort_reason" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hypotheses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"parent_hypothesis_id" uuid,
	"title" text NOT NULL,
	"rationale" text,
	"source" text DEFAULT 'ai' NOT NULL,
	"source_context" jsonb,
	"status" text DEFAULT 'proposed' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "measurements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"metric_definition_id" uuid NOT NULL,
	"experiment_id" uuid,
	"cycle_id" uuid,
	"value" double precision NOT NULL,
	"raw_data" jsonb,
	"sample_size" integer,
	"confidence_interval" jsonb,
	"collected_at" timestamp with time zone NOT NULL,
	"collection_method" text NOT NULL,
	"data_source_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"unit" text,
	"data_source_type" text NOT NULL,
	"data_source_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"aggregation" text DEFAULT 'latest' NOT NULL,
	"collection_method" text DEFAULT 'poll' NOT NULL,
	"poll_interval_minutes" integer,
	"plugin_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"owner_agent_id" uuid,
	"max_iterations" integer,
	"current_iteration" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_cycle_id_research_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."research_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_hypothesis_id_hypotheses_id_fk" FOREIGN KEY ("hypothesis_id") REFERENCES "public"."hypotheses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_evaluated_by_agent_id_agents_id_fk" FOREIGN KEY ("evaluated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_cycle_id_research_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."research_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_hypothesis_id_hypotheses_id_fk" FOREIGN KEY ("hypothesis_id") REFERENCES "public"."hypotheses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_budget_policy_id_budget_policies_id_fk" FOREIGN KEY ("budget_policy_id") REFERENCES "public"."budget_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_cycle_id_research_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."research_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_parent_hypothesis_id_hypotheses_id_fk" FOREIGN KEY ("parent_hypothesis_id") REFERENCES "public"."hypotheses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_metric_definition_id_metric_definitions_id_fk" FOREIGN KEY ("metric_definition_id") REFERENCES "public"."metric_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_cycle_id_research_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."research_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_definitions" ADD CONSTRAINT "metric_definitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_definitions" ADD CONSTRAINT "metric_definitions_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_cycles" ADD CONSTRAINT "research_cycles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_cycles" ADD CONSTRAINT "research_cycles_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_cycles" ADD CONSTRAINT "research_cycles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_cycles" ADD CONSTRAINT "research_cycles_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_cycles" ADD CONSTRAINT "research_cycles_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluations_experiment_unique" ON "evaluations" USING btree ("experiment_id");--> statement-breakpoint
CREATE INDEX "evaluations_cycle_idx" ON "evaluations" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "experiments_company_cycle_idx" ON "experiments" USING btree ("company_id","cycle_id","status");--> statement-breakpoint
CREATE INDEX "experiments_hypothesis_idx" ON "experiments" USING btree ("hypothesis_id");--> statement-breakpoint
CREATE INDEX "experiments_status_idx" ON "experiments" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "hypotheses_company_cycle_idx" ON "hypotheses" USING btree ("company_id","cycle_id","status");--> statement-breakpoint
CREATE INDEX "hypotheses_parent_idx" ON "hypotheses" USING btree ("parent_hypothesis_id");--> statement-breakpoint
CREATE INDEX "measurements_company_metric_idx" ON "measurements" USING btree ("company_id","metric_definition_id","collected_at");--> statement-breakpoint
CREATE INDEX "measurements_experiment_idx" ON "measurements" USING btree ("experiment_id","collected_at");--> statement-breakpoint
CREATE INDEX "measurements_cycle_idx" ON "measurements" USING btree ("cycle_id","collected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_definitions_company_key_unique" ON "metric_definitions" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "metric_definitions_company_idx" ON "metric_definitions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "research_cycles_company_status_idx" ON "research_cycles" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "research_cycles_goal_idx" ON "research_cycles" USING btree ("company_id","goal_id");