CREATE TABLE "box_upgrades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"box_id" uuid NOT NULL,
	"rollout_id" uuid,
	"wave" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'planned' NOT NULL,
	"job_id" uuid,
	"to_tag" text NOT NULL,
	"to_digest" text NOT NULL,
	"to_commit" text,
	"from_tag" text,
	"from_digest" text,
	"from_build_source" text,
	"from_source_commit" text,
	"from_deployment_id" text,
	"snapshots" jsonb,
	"deployment_id" text,
	"rollback_deployment_id" text,
	"error" text,
	"last_health" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "box_upgrades_state_ck" CHECK (state in ('planned', 'queued', 'running', 'rolling_back', 'succeeded', 'rolled_back', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "rollouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_tag" text NOT NULL,
	"image_digest" text NOT NULL,
	"release_commit" text,
	"state" text DEFAULT 'running' NOT NULL,
	"ignore_window" boolean DEFAULT false NOT NULL,
	"paused_reason" text,
	"created_by" text NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rollouts_state_ck" CHECK (state in ('running', 'completed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "purpose" text DEFAULT 'customer' NOT NULL;--> statement-breakpoint
ALTER TABLE "box_upgrades" ADD CONSTRAINT "box_upgrades_box_id_boxes_id_fk" FOREIGN KEY ("box_id") REFERENCES "public"."boxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "box_upgrades" ADD CONSTRAINT "box_upgrades_rollout_id_rollouts_id_fk" FOREIGN KEY ("rollout_id") REFERENCES "public"."rollouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "box_upgrades" ADD CONSTRAINT "box_upgrades_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "box_upgrades_rollout_idx" ON "box_upgrades" USING btree ("rollout_id","wave","state");--> statement-breakpoint
CREATE INDEX "box_upgrades_box_idx" ON "box_upgrades" USING btree ("box_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "box_upgrades_rollout_box_uq" ON "box_upgrades" USING btree ("rollout_id","box_id");--> statement-breakpoint
CREATE UNIQUE INDEX "box_upgrades_one_live_per_box_uq" ON "box_upgrades" USING btree ("box_id") WHERE state in ('queued', 'running', 'rolling_back');--> statement-breakpoint
CREATE UNIQUE INDEX "rollouts_one_running_uq" ON "rollouts" USING btree ("state") WHERE state = 'running';--> statement-breakpoint
ALTER TABLE "boxes" ADD CONSTRAINT "boxes_purpose_ck" CHECK (purpose in ('customer', 'demo', 'canary', 'internal'));