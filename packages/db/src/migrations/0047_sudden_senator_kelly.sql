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
ALTER TABLE "agent_key_results" ADD CONSTRAINT "agent_key_results_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_key_results" ADD CONSTRAINT "agent_key_results_okr_id_agent_okrs_id_fk" FOREIGN KEY ("okr_id") REFERENCES "public"."agent_okrs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_okrs" ADD CONSTRAINT "agent_okrs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_okrs" ADD CONSTRAINT "agent_okrs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_okrs" ADD CONSTRAINT "agent_okrs_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spawn_requests" ADD CONSTRAINT "spawn_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spawn_requests" ADD CONSTRAINT "spawn_requests_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spawn_requests" ADD CONSTRAINT "spawn_requests_template_id_agent_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."agent_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spawn_requests" ADD CONSTRAINT "spawn_requests_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spawn_requests" ADD CONSTRAINT "spawn_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_key_results_okr_idx" ON "agent_key_results" USING btree ("okr_id");--> statement-breakpoint
CREATE INDEX "agent_okrs_company_agent_status_idx" ON "agent_okrs" USING btree ("company_id","agent_id","status");--> statement-breakpoint
CREATE INDEX "agent_okrs_company_agent_period_idx" ON "agent_okrs" USING btree ("company_id","agent_id","period_end");--> statement-breakpoint
CREATE INDEX "spawn_requests_company_status_idx" ON "spawn_requests" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "spawn_requests_company_approval_idx" ON "spawn_requests" USING btree ("company_id","approval_id");--> statement-breakpoint
CREATE INDEX "spawn_requests_company_template_idx" ON "spawn_requests" USING btree ("company_id","template_id");