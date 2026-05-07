-- AgentDash: goals-eval-hitl Phase A
-- Adds JSONB columns for metric definition and Definition of Done; introduces
-- new tables `verdicts`, `cos_reviewer_assignments`, `issue_review_queue_state`,
-- and `feature_flags`; backfills `dod_guard_enabled=false` for existing
-- companies; creates the `issue_review_timeline_v` UNION view consumed by the
-- Issue-detail timeline UI.

ALTER TABLE "goals" ADD COLUMN "metric_definition" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "definition_of_done" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "definition_of_done" jsonb;--> statement-breakpoint

CREATE TABLE "verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"goal_id" uuid,
	"project_id" uuid,
	"issue_id" uuid,
	"reviewer_agent_id" uuid,
	"reviewer_user_id" text,
	"outcome" text NOT NULL,
	"rubric_scores" jsonb,
	"justification" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verdicts_entity_target_check" CHECK (
		(entity_type = 'goal'    AND goal_id    IS NOT NULL AND project_id IS NULL     AND issue_id   IS NULL)
		OR (entity_type = 'project' AND project_id IS NOT NULL AND goal_id    IS NULL     AND issue_id   IS NULL)
		OR (entity_type = 'issue'   AND issue_id   IS NOT NULL AND goal_id    IS NULL     AND project_id IS NULL)
	),
	CONSTRAINT "verdicts_reviewer_xor_check" CHECK ((reviewer_agent_id IS NOT NULL) <> (reviewer_user_id IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verdicts_company_entity_idx" ON "verdicts" USING btree ("company_id","entity_type","goal_id","project_id","issue_id");--> statement-breakpoint
CREATE INDEX "verdicts_company_created_idx" ON "verdicts" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "verdicts_closing_idx" ON "verdicts" USING btree ("company_id","entity_type","goal_id","project_id","issue_id") WHERE "outcome" IN ('passed','failed','escalated_to_human');--> statement-breakpoint

CREATE TABLE "cos_reviewer_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"reviewer_agent_id" uuid NOT NULL,
	"queue_partition" text,
	"hired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"queue_depth_at_spawn" integer
);
--> statement-breakpoint
ALTER TABLE "cos_reviewer_assignments" ADD CONSTRAINT "cos_reviewer_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cos_reviewer_assignments" ADD CONSTRAINT "cos_reviewer_assignments_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cos_reviewer_assignments_active_idx" ON "cos_reviewer_assignments" USING btree ("company_id") WHERE "retired_at" IS NULL;--> statement-breakpoint
CREATE INDEX "cos_reviewer_assignments_history_idx" ON "cos_reviewer_assignments" USING btree ("company_id","hired_at");--> statement-breakpoint

CREATE TABLE "issue_review_queue_state" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"escalate_after" timestamp with time zone,
	"assigned_reviewer_agent_id" uuid
);
--> statement-breakpoint
ALTER TABLE "issue_review_queue_state" ADD CONSTRAINT "issue_review_queue_state_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_review_queue_state" ADD CONSTRAINT "issue_review_queue_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_review_queue_state" ADD CONSTRAINT "issue_review_queue_state_assigned_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("assigned_reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_review_queue_state_enqueued_idx" ON "issue_review_queue_state" USING btree ("company_id","enqueued_at");--> statement-breakpoint
CREATE INDEX "issue_review_queue_state_escalate_idx" ON "issue_review_queue_state" USING btree ("company_id","escalate_after") WHERE "escalate_after" IS NOT NULL;--> statement-breakpoint

CREATE TABLE "feature_flags" (
	"company_id" uuid NOT NULL,
	"flag_key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flags_pk" PRIMARY KEY("company_id","flag_key")
);
--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Backfill: existing tenants start with `dod_guard_enabled=false` so in-flight
-- Issues without DoD continue to transition. Newly-created tenants receive
-- `enabled=true` from the company-create service path (Phase C7).
INSERT INTO "feature_flags" ("company_id", "flag_key", "enabled")
	SELECT "id", 'dod_guard_enabled', false FROM "companies"
	ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- View: chronologically merges pipeline-stage decisions and eval verdicts
-- for a given Issue. Consumed by the Issue-detail review-timeline endpoint
-- and `VerdictTimeline.tsx`. Re-creatable via `CREATE OR REPLACE` in case a
-- future migration alters the underlying tables.
CREATE OR REPLACE VIEW "issue_review_timeline_v" AS
	SELECT
		"company_id"  AS "company_id",
		"issue_id"    AS "issue_id",
		'execution_decision'::text AS "source",
		"id"          AS "row_id",
		"created_at"  AS "created_at",
		"outcome"     AS "outcome",
		"body"        AS "body",
		"actor_agent_id" AS "reviewer_agent_id",
		"actor_user_id"  AS "reviewer_user_id"
	FROM "issue_execution_decisions"
	UNION ALL
	SELECT
		"company_id" AS "company_id",
		"issue_id"   AS "issue_id",
		'verdict'::text AS "source",
		"id"         AS "row_id",
		"created_at" AS "created_at",
		"outcome"    AS "outcome",
		"justification" AS "body",
		"reviewer_agent_id" AS "reviewer_agent_id",
		"reviewer_user_id"  AS "reviewer_user_id"
	FROM "verdicts"
	WHERE "entity_type" = 'issue' AND "issue_id" IS NOT NULL;
