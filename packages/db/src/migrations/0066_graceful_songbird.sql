CREATE TABLE "pipeline_stage_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_run_id" uuid NOT NULL,
	"stage_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"heartbeat_run_id" uuid,
	"input_state" jsonb,
	"output_state" jsonb,
	"cost_usd" numeric DEFAULT '0',
	"self_heal_attempts" integer DEFAULT 0 NOT NULL,
	"self_heal_log" jsonb DEFAULT '[]'::jsonb,
	"approval_id" uuid,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_pipelines" ADD COLUMN "edges" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_pipelines" ADD COLUMN "execution_mode" text DEFAULT 'sync' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_pipelines" ADD COLUMN "defaults" jsonb;--> statement-breakpoint
ALTER TABLE "agent_pipelines" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "agent_pipelines" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "execution_mode" text DEFAULT 'sync' NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "active_stage_ids" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "total_cost_usd" numeric DEFAULT '0';--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "triggered_by" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pipeline_stage_executions" ADD CONSTRAINT "pipeline_stage_executions_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_stage_exec_run_idx" ON "pipeline_stage_executions" USING btree ("pipeline_run_id");--> statement-breakpoint
CREATE INDEX "pipeline_stage_exec_stage_idx" ON "pipeline_stage_executions" USING btree ("pipeline_run_id","stage_id");