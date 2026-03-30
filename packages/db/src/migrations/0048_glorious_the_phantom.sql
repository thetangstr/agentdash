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
ALTER TABLE "agent_sandboxes" ADD CONSTRAINT "agent_sandboxes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sandboxes" ADD CONSTRAINT "agent_sandboxes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kill_switch_events" ADD CONSTRAINT "kill_switch_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_evaluations" ADD CONSTRAINT "policy_evaluations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_evaluations" ADD CONSTRAINT "policy_evaluations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_evaluations" ADD CONSTRAINT "policy_evaluations_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_policies" ADD CONSTRAINT "security_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sandboxes_company_agent_unique" ON "agent_sandboxes" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "kill_switch_events_company_time_idx" ON "kill_switch_events" USING btree ("company_id","triggered_at");--> statement-breakpoint
CREATE INDEX "kill_switch_events_scope_idx" ON "kill_switch_events" USING btree ("scope","scope_id");--> statement-breakpoint
CREATE INDEX "policy_evaluations_company_time_idx" ON "policy_evaluations" USING btree ("company_id","evaluated_at");--> statement-breakpoint
CREATE INDEX "policy_evaluations_company_agent_idx" ON "policy_evaluations" USING btree ("company_id","agent_id","evaluated_at");--> statement-breakpoint
CREATE INDEX "policy_evaluations_company_decision_idx" ON "policy_evaluations" USING btree ("company_id","decision");--> statement-breakpoint
CREATE INDEX "security_policies_company_type_active_idx" ON "security_policies" USING btree ("company_id","policy_type","is_active");--> statement-breakpoint
CREATE INDEX "security_policies_company_target_idx" ON "security_policies" USING btree ("company_id","target_type","target_id","is_active");