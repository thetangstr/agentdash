CREATE TABLE "agent_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"role" text DEFAULT 'general' NOT NULL,
	"icon" text,
	"adapter_type" text DEFAULT 'claude_local' NOT NULL,
	"adapter_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"runtime_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"skill_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"instructions_template" text,
	"okrs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kpis" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"authority_level" text DEFAULT 'executor' NOT NULL,
	"task_classification" text DEFAULT 'deterministic' NOT NULL,
	"estimated_cost_per_task_cents" integer,
	"estimated_minutes_per_task" integer,
	"budget_monthly_cents" integer DEFAULT 0 NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"blocked_by_issue_id" uuid NOT NULL,
	"dependency_type" text DEFAULT 'blocks' NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_templates" ADD CONSTRAINT "agent_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_blocked_by_issue_id_issues_id_fk" FOREIGN KEY ("blocked_by_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_templates_company_slug_unique" ON "agent_templates" USING btree ("company_id","slug");--> statement-breakpoint
CREATE INDEX "agent_templates_company_role_idx" ON "agent_templates" USING btree ("company_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_dependencies_unique_edge" ON "issue_dependencies" USING btree ("issue_id","blocked_by_issue_id");--> statement-breakpoint
CREATE INDEX "issue_dependencies_company_issue_idx" ON "issue_dependencies" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_dependencies_company_blocker_idx" ON "issue_dependencies" USING btree ("company_id","blocked_by_issue_id");