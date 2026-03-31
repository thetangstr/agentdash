CREATE TABLE "agent_pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"stages" jsonb NOT NULL,
	"metadata" jsonb,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"trigger_issue_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"current_stage_index" integer DEFAULT 0 NOT NULL,
	"stage_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "crm_account_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_pipelines" ADD CONSTRAINT "agent_pipelines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_pipeline_id_agent_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."agent_pipelines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_trigger_issue_id_issues_id_fk" FOREIGN KEY ("trigger_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_pipelines_company_status_idx" ON "agent_pipelines" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "pipeline_runs_company_status_idx" ON "pipeline_runs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "pipeline_runs_pipeline_idx" ON "pipeline_runs" USING btree ("pipeline_id");--> statement-breakpoint
CREATE INDEX "pipeline_runs_trigger_issue_idx" ON "pipeline_runs" USING btree ("trigger_issue_id");