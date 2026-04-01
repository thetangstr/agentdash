ALTER TABLE "company_skills" ADD COLUMN "when_to_use" text;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "activation_paths" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "execution_context" text DEFAULT 'inline' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "target_agent_type" text;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "effort" text;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "user_invocable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "hooks" jsonb;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "issue_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "parent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "delegation_kind" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "delegation_label" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "requested_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "requested_by_user_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "requested_skill_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "requested_skill_version_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD COLUMN "when_to_use" text;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD COLUMN "allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD COLUMN "activation_paths" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD COLUMN "execution_context" text DEFAULT 'inline' NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD COLUMN "target_agent_type" text;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD COLUMN "effort" text;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD COLUMN "user_invocable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD COLUMN "hooks" jsonb;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_parent_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_requested_skill_id_company_skills_id_fk" FOREIGN KEY ("requested_skill_id") REFERENCES "public"."company_skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_requested_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("requested_skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action;