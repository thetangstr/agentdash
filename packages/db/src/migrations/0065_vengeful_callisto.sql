CREATE TABLE "agent_key_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"okr_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"target_value" numeric NOT NULL,
	"current_value" numeric DEFAULT '0' NOT NULL,
	"unit" text DEFAULT 'count' NOT NULL,
	"weight" numeric DEFAULT '1.0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_okrs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"goal_id" uuid,
	"objective" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"period" text DEFAULT 'quarterly' NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"stages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"current_stage" integer DEFAULT 0 NOT NULL,
	"input_data" jsonb,
	"output_data" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_sandboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"isolation_level" text DEFAULT 'process' NOT NULL,
	"network_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"filesystem_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resource_limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"environment_vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_access" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_service_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"email" text,
	"display_name" text,
	"encrypted_tokens" jsonb,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
	"department_id" uuid,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"parent_policy_id" uuid NOT NULL,
	"child_policy_id" uuid NOT NULL,
	"allocated_amount" integer NOT NULL,
	"is_flexible" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_forecasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"forecast_type" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"projected_amount" integer NOT NULL,
	"confidence" numeric(5, 4),
	"inputs" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"credential_mode" text DEFAULT 'service_account' NOT NULL,
	"encrypted_tokens" jsonb,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"connected_by" uuid,
	"connected_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"error_message" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"context_type" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"confidence" numeric(3, 2) DEFAULT '0.80' NOT NULL,
	"source_id" uuid,
	"verified_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"industry" text,
	"size" text,
	"stage" text,
	"owner_agent_id" uuid,
	"owner_user_id" text,
	"external_id" text,
	"external_source" text,
	"metadata" jsonb,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"account_id" uuid,
	"contact_id" uuid,
	"deal_id" uuid,
	"activity_type" text NOT NULL,
	"subject" text,
	"body" text,
	"performed_by_agent_id" uuid,
	"performed_by_user_id" text,
	"external_id" text,
	"external_source" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"account_id" uuid,
	"first_name" text,
	"last_name" text,
	"email" text,
	"phone" text,
	"title" text,
	"owner_agent_id" uuid,
	"owner_user_id" text,
	"external_id" text,
	"external_source" text,
	"metadata" jsonb,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"account_id" uuid,
	"contact_id" uuid,
	"name" text NOT NULL,
	"stage" text,
	"amount_cents" text,
	"currency" text DEFAULT 'USD',
	"close_date" timestamp with time zone,
	"probability" text,
	"owner_agent_id" uuid,
	"owner_user_id" text,
	"linked_project_id" uuid,
	"linked_issue_id" uuid,
	"external_id" text,
	"external_source" text,
	"metadata" jsonb,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"first_name" text,
	"last_name" text,
	"email" text,
	"phone" text,
	"company" text,
	"title" text,
	"source" text,
	"status" text DEFAULT 'new' NOT NULL,
	"score" text,
	"owner_agent_id" uuid,
	"owner_user_id" text,
	"converted_account_id" uuid,
	"converted_contact_id" uuid,
	"converted_at" timestamp with time zone,
	"external_id" text,
	"external_source" text,
	"metadata" jsonb,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'referral' NOT NULL,
	"contact_name" text,
	"contact_email" text,
	"website" text,
	"status" text DEFAULT 'active' NOT NULL,
	"tier" text,
	"referral_count" text,
	"revenue_attributed_cents" text,
	"owner_agent_id" uuid,
	"owner_user_id" text,
	"linked_account_id" uuid,
	"external_id" text,
	"external_source" text,
	"metadata" jsonb,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"parent_id" uuid,
	"lead_user_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"pause_reason" text,
	"paused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "kill_switch_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"triggered_by_user_id" text NOT NULL,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "onboarding_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"current_step" text DEFAULT 'discovery' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" text NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_locator" text NOT NULL,
	"raw_content" text,
	"extracted_summary" text,
	"extracted_entities" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"action" text NOT NULL,
	"resource" text,
	"matched_policy_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decision" text NOT NULL,
	"denial_reason" text,
	"context" jsonb,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "resource_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"project_id" uuid,
	"resource_type" text NOT NULL,
	"resource_provider" text NOT NULL,
	"quantity" numeric NOT NULL,
	"unit" text NOT NULL,
	"cost_cents" integer,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"policy_type" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"rules" jsonb NOT NULL,
	"effect" text DEFAULT 'deny' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"depends_on_skill_id" uuid NOT NULL,
	"version_constraint" text,
	"is_required" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"version_id" uuid,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"issue_id" uuid,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"semver" text,
	"markdown" text NOT NULL,
	"when_to_use" text,
	"allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"activation_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"execution_context" text DEFAULT 'inline' NOT NULL,
	"target_agent_type" text,
	"effort" text,
	"user_invocable" boolean DEFAULT true NOT NULL,
	"hooks" jsonb,
	"file_inventory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb,
	"change_summary" text,
	"diff_from_previous" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"deprecated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spawn_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"approval_id" uuid,
	"template_id" uuid,
	"requested_by_agent_id" uuid,
	"requested_by_user_id" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"reason" text,
	"project_id" uuid,
	"agent_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"spawned_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fulfilled_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "credential_mode" text DEFAULT 'claw' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "theme_accent_color" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "when_to_use" text;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "activation_paths" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "execution_context" text DEFAULT 'inline' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "target_agent_type" text;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "effort" text;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "user_invocable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "hooks" jsonb;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "published_version_id" uuid;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "latest_version_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "priority" text DEFAULT 'medium';--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "target_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "issue_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "parent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "delegation_kind" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "delegation_label" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "requested_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "requested_by_user_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "requested_skill_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "requested_skill_version_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "crm_account_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_key_results" ADD CONSTRAINT "agent_key_results_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_key_results" ADD CONSTRAINT "agent_key_results_okr_id_agent_okrs_id_fk" FOREIGN KEY ("okr_id") REFERENCES "public"."agent_okrs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_okrs" ADD CONSTRAINT "agent_okrs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_okrs" ADD CONSTRAINT "agent_okrs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_okrs" ADD CONSTRAINT "agent_okrs_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_pipelines" ADD CONSTRAINT "agent_pipelines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_pipeline_id_agent_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."agent_pipelines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sandboxes" ADD CONSTRAINT "agent_sandboxes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sandboxes" ADD CONSTRAINT "agent_sandboxes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_service_accounts" ADD CONSTRAINT "agent_service_accounts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_service_accounts" ADD CONSTRAINT "agent_service_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_templates" ADD CONSTRAINT "agent_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_templates" ADD CONSTRAINT "agent_templates_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_allocations" ADD CONSTRAINT "budget_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_allocations" ADD CONSTRAINT "budget_allocations_parent_policy_id_budget_policies_id_fk" FOREIGN KEY ("parent_policy_id") REFERENCES "public"."budget_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_allocations" ADD CONSTRAINT "budget_allocations_child_policy_id_budget_policies_id_fk" FOREIGN KEY ("child_policy_id") REFERENCES "public"."budget_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_forecasts" ADD CONSTRAINT "budget_forecasts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_forecasts" ADD CONSTRAINT "budget_forecasts_policy_id_budget_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."budget_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_connectors" ADD CONSTRAINT "company_connectors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_context" ADD CONSTRAINT "company_context_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_context" ADD CONSTRAINT "company_context_source_id_onboarding_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."onboarding_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_accounts" ADD CONSTRAINT "crm_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_account_id_crm_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."crm_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_contact_id_crm_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."crm_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_deal_id_crm_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."crm_deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_account_id_crm_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."crm_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_account_id_crm_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."crm_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_contact_id_crm_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."crm_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_converted_account_id_crm_accounts_id_fk" FOREIGN KEY ("converted_account_id") REFERENCES "public"."crm_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_converted_contact_id_crm_contacts_id_fk" FOREIGN KEY ("converted_contact_id") REFERENCES "public"."crm_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_partners" ADD CONSTRAINT "crm_partners_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_partners" ADD CONSTRAINT "crm_partners_linked_account_id_crm_accounts_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."crm_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_parent_id_departments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_blocked_by_issue_id_issues_id_fk" FOREIGN KEY ("blocked_by_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kill_switch_events" ADD CONSTRAINT "kill_switch_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_metric_definition_id_metric_definitions_id_fk" FOREIGN KEY ("metric_definition_id") REFERENCES "public"."metric_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_cycle_id_research_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."research_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_definitions" ADD CONSTRAINT "metric_definitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_definitions" ADD CONSTRAINT "metric_definitions_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_sessions" ADD CONSTRAINT "onboarding_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_sources" ADD CONSTRAINT "onboarding_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_sources" ADD CONSTRAINT "onboarding_sources_session_id_onboarding_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."onboarding_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_evaluations" ADD CONSTRAINT "policy_evaluations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_evaluations" ADD CONSTRAINT "policy_evaluations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_evaluations" ADD CONSTRAINT "policy_evaluations_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_cycles" ADD CONSTRAINT "research_cycles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_cycles" ADD CONSTRAINT "research_cycles_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_cycles" ADD CONSTRAINT "research_cycles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_cycles" ADD CONSTRAINT "research_cycles_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_cycles" ADD CONSTRAINT "research_cycles_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_usage_events" ADD CONSTRAINT "resource_usage_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_usage_events" ADD CONSTRAINT "resource_usage_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_usage_events" ADD CONSTRAINT "resource_usage_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_policies" ADD CONSTRAINT "security_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_dependencies" ADD CONSTRAINT "skill_dependencies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_dependencies" ADD CONSTRAINT "skill_dependencies_skill_id_company_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_dependencies" ADD CONSTRAINT "skill_dependencies_depends_on_skill_id_company_skills_id_fk" FOREIGN KEY ("depends_on_skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_skill_id_company_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."company_skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_version_id_skill_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."skill_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_company_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spawn_requests" ADD CONSTRAINT "spawn_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spawn_requests" ADD CONSTRAINT "spawn_requests_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spawn_requests" ADD CONSTRAINT "spawn_requests_template_id_agent_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."agent_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spawn_requests" ADD CONSTRAINT "spawn_requests_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spawn_requests" ADD CONSTRAINT "spawn_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_key_results_okr_idx" ON "agent_key_results" USING btree ("okr_id");--> statement-breakpoint
CREATE INDEX "agent_okrs_company_agent_status_idx" ON "agent_okrs" USING btree ("company_id","agent_id","status");--> statement-breakpoint
CREATE INDEX "agent_okrs_company_agent_period_idx" ON "agent_okrs" USING btree ("company_id","agent_id","period_end");--> statement-breakpoint
CREATE INDEX "agent_pipelines_company_idx" ON "agent_pipelines" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "pipeline_runs_pipeline_idx" ON "pipeline_runs" USING btree ("pipeline_id");--> statement-breakpoint
CREATE INDEX "pipeline_runs_company_idx" ON "pipeline_runs" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sandboxes_company_agent_unique" ON "agent_sandboxes" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_service_accounts_unique_idx" ON "agent_service_accounts" USING btree ("agent_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_templates_company_slug_unique" ON "agent_templates" USING btree ("company_id","slug");--> statement-breakpoint
CREATE INDEX "agent_templates_company_role_idx" ON "agent_templates" USING btree ("company_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_allocations_parent_child_unique" ON "budget_allocations" USING btree ("parent_policy_id","child_policy_id");--> statement-breakpoint
CREATE INDEX "budget_allocations_company_parent_idx" ON "budget_allocations" USING btree ("company_id","parent_policy_id");--> statement-breakpoint
CREATE INDEX "budget_forecasts_company_policy_idx" ON "budget_forecasts" USING btree ("company_id","policy_id","forecast_type","computed_at");--> statement-breakpoint
CREATE INDEX "company_connectors_company_idx" ON "company_connectors" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_connectors_unique_idx" ON "company_connectors" USING btree ("company_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "company_context_company_type_key_unique" ON "company_context" USING btree ("company_id","context_type","key");--> statement-breakpoint
CREATE INDEX "company_context_company_type_idx" ON "company_context" USING btree ("company_id","context_type");--> statement-breakpoint
CREATE INDEX "crm_accounts_company_idx" ON "crm_accounts" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_accounts_external_unique" ON "crm_accounts" USING btree ("company_id","external_source","external_id");--> statement-breakpoint
CREATE INDEX "crm_activities_company_idx" ON "crm_activities" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "crm_activities_account_idx" ON "crm_activities" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "crm_activities_deal_idx" ON "crm_activities" USING btree ("deal_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_activities_external_unique" ON "crm_activities" USING btree ("company_id","external_source","external_id");--> statement-breakpoint
CREATE INDEX "crm_contacts_company_idx" ON "crm_contacts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "crm_contacts_account_idx" ON "crm_contacts" USING btree ("company_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_contacts_external_unique" ON "crm_contacts" USING btree ("company_id","external_source","external_id");--> statement-breakpoint
CREATE INDEX "crm_deals_company_idx" ON "crm_deals" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "crm_deals_account_idx" ON "crm_deals" USING btree ("company_id","account_id");--> statement-breakpoint
CREATE INDEX "crm_deals_stage_idx" ON "crm_deals" USING btree ("company_id","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_deals_external_unique" ON "crm_deals" USING btree ("company_id","external_source","external_id");--> statement-breakpoint
CREATE INDEX "crm_leads_company_status_idx" ON "crm_leads" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "crm_leads_company_source_idx" ON "crm_leads" USING btree ("company_id","source");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_leads_external_unique" ON "crm_leads" USING btree ("company_id","external_source","external_id");--> statement-breakpoint
CREATE INDEX "crm_partners_company_status_idx" ON "crm_partners" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "crm_partners_company_type_idx" ON "crm_partners" USING btree ("company_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_partners_external_unique" ON "crm_partners" USING btree ("company_id","external_source","external_id");--> statement-breakpoint
CREATE INDEX "departments_company_idx" ON "departments" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "departments_company_parent_idx" ON "departments" USING btree ("company_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "departments_company_name_unique" ON "departments" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluations_experiment_unique" ON "evaluations" USING btree ("experiment_id");--> statement-breakpoint
CREATE INDEX "evaluations_cycle_idx" ON "evaluations" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "experiments_company_cycle_idx" ON "experiments" USING btree ("company_id","cycle_id","status");--> statement-breakpoint
CREATE INDEX "experiments_hypothesis_idx" ON "experiments" USING btree ("hypothesis_id");--> statement-breakpoint
CREATE INDEX "experiments_status_idx" ON "experiments" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "hypotheses_company_cycle_idx" ON "hypotheses" USING btree ("company_id","cycle_id","status");--> statement-breakpoint
CREATE INDEX "hypotheses_parent_idx" ON "hypotheses" USING btree ("parent_hypothesis_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_dependencies_unique_edge" ON "issue_dependencies" USING btree ("issue_id","blocked_by_issue_id");--> statement-breakpoint
CREATE INDEX "issue_dependencies_company_issue_idx" ON "issue_dependencies" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_dependencies_company_blocker_idx" ON "issue_dependencies" USING btree ("company_id","blocked_by_issue_id");--> statement-breakpoint
CREATE INDEX "kill_switch_events_company_time_idx" ON "kill_switch_events" USING btree ("company_id","triggered_at");--> statement-breakpoint
CREATE INDEX "kill_switch_events_scope_idx" ON "kill_switch_events" USING btree ("scope","scope_id");--> statement-breakpoint
CREATE INDEX "measurements_company_metric_idx" ON "measurements" USING btree ("company_id","metric_definition_id","collected_at");--> statement-breakpoint
CREATE INDEX "measurements_experiment_idx" ON "measurements" USING btree ("experiment_id","collected_at");--> statement-breakpoint
CREATE INDEX "measurements_cycle_idx" ON "measurements" USING btree ("cycle_id","collected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_definitions_company_key_unique" ON "metric_definitions" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "metric_definitions_company_idx" ON "metric_definitions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "onboarding_sessions_company_status_idx" ON "onboarding_sessions" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "onboarding_sources_company_session_idx" ON "onboarding_sources" USING btree ("company_id","session_id");--> statement-breakpoint
CREATE INDEX "policy_evaluations_company_time_idx" ON "policy_evaluations" USING btree ("company_id","evaluated_at");--> statement-breakpoint
CREATE INDEX "policy_evaluations_company_agent_idx" ON "policy_evaluations" USING btree ("company_id","agent_id","evaluated_at");--> statement-breakpoint
CREATE INDEX "policy_evaluations_company_decision_idx" ON "policy_evaluations" USING btree ("company_id","decision");--> statement-breakpoint
CREATE INDEX "research_cycles_company_status_idx" ON "research_cycles" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "research_cycles_goal_idx" ON "research_cycles" USING btree ("company_id","goal_id");--> statement-breakpoint
CREATE INDEX "resource_usage_events_company_type_idx" ON "resource_usage_events" USING btree ("company_id","resource_type","occurred_at");--> statement-breakpoint
CREATE INDEX "resource_usage_events_company_agent_idx" ON "resource_usage_events" USING btree ("company_id","agent_id","resource_type","occurred_at");--> statement-breakpoint
CREATE INDEX "security_policies_company_type_active_idx" ON "security_policies" USING btree ("company_id","policy_type","is_active");--> statement-breakpoint
CREATE INDEX "security_policies_company_target_idx" ON "security_policies" USING btree ("company_id","target_type","target_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_dependencies_unique" ON "skill_dependencies" USING btree ("skill_id","depends_on_skill_id");--> statement-breakpoint
CREATE INDEX "skill_dependencies_depends_on_idx" ON "skill_dependencies" USING btree ("depends_on_skill_id");--> statement-breakpoint
CREATE INDEX "skill_usage_events_company_skill_idx" ON "skill_usage_events" USING btree ("company_id","skill_id","used_at");--> statement-breakpoint
CREATE INDEX "skill_usage_events_company_agent_idx" ON "skill_usage_events" USING btree ("company_id","agent_id","used_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_skill_version_unique" ON "skill_versions" USING btree ("skill_id","version_number");--> statement-breakpoint
CREATE INDEX "skill_versions_company_skill_status_idx" ON "skill_versions" USING btree ("company_id","skill_id","status");--> statement-breakpoint
CREATE INDEX "spawn_requests_company_status_idx" ON "spawn_requests" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "spawn_requests_company_approval_idx" ON "spawn_requests" USING btree ("company_id","approval_id");--> statement-breakpoint
CREATE INDEX "spawn_requests_company_template_idx" ON "spawn_requests" USING btree ("company_id","template_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_parent_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_requested_skill_id_company_skills_id_fk" FOREIGN KEY ("requested_skill_id") REFERENCES "public"."company_skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_requested_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("requested_skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;