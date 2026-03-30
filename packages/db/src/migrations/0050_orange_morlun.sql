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
ALTER TABLE "agents" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "budget_allocations" ADD CONSTRAINT "budget_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_allocations" ADD CONSTRAINT "budget_allocations_parent_policy_id_budget_policies_id_fk" FOREIGN KEY ("parent_policy_id") REFERENCES "public"."budget_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_allocations" ADD CONSTRAINT "budget_allocations_child_policy_id_budget_policies_id_fk" FOREIGN KEY ("child_policy_id") REFERENCES "public"."budget_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_forecasts" ADD CONSTRAINT "budget_forecasts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_forecasts" ADD CONSTRAINT "budget_forecasts_policy_id_budget_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."budget_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_parent_id_departments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_usage_events" ADD CONSTRAINT "resource_usage_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_usage_events" ADD CONSTRAINT "resource_usage_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_usage_events" ADD CONSTRAINT "resource_usage_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_allocations_parent_child_unique" ON "budget_allocations" USING btree ("parent_policy_id","child_policy_id");--> statement-breakpoint
CREATE INDEX "budget_allocations_company_parent_idx" ON "budget_allocations" USING btree ("company_id","parent_policy_id");--> statement-breakpoint
CREATE INDEX "budget_forecasts_company_policy_idx" ON "budget_forecasts" USING btree ("company_id","policy_id","forecast_type","computed_at");--> statement-breakpoint
CREATE INDEX "departments_company_idx" ON "departments" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "departments_company_parent_idx" ON "departments" USING btree ("company_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "departments_company_name_unique" ON "departments" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "resource_usage_events_company_type_idx" ON "resource_usage_events" USING btree ("company_id","resource_type","occurred_at");--> statement-breakpoint
CREATE INDEX "resource_usage_events_company_agent_idx" ON "resource_usage_events" USING btree ("company_id","agent_id","resource_type","occurred_at");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;