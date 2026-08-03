CREATE TABLE "workflow_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pipeline_id" text NOT NULL,
	"step_key" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"cycles_observed" integer NOT NULL,
	"evidence_cycles" integer NOT NULL,
	"latest_run_id" text NOT NULL,
	"observation" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"recipient_user_id" text NOT NULL,
	"approval_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "workflow_recommendations_kind_ck" CHECK ("workflow_recommendations"."kind" in ('recurring_correction', 'chronic_escalation_stall')),
	CONSTRAINT "workflow_recommendations_status_ck" CHECK ("workflow_recommendations"."status" in ('open', 'accepted', 'declined')),
	CONSTRAINT "workflow_recommendations_minimum_cycles_ck" CHECK ("workflow_recommendations"."evidence_cycles" >= 3 and "workflow_recommendations"."cycles_observed" >= "workflow_recommendations"."evidence_cycles"),
	CONSTRAINT "workflow_recommendations_step_not_a_seat_ck" CHECK ("workflow_recommendations"."step_key" !~* '^approval[._]|^approver[._]?[0-9]|_approver_?[0-9]'),
	CONSTRAINT "workflow_recommendations_cites_evidence_ck" CHECK (jsonb_typeof("workflow_recommendations"."evidence") = 'object'
          and jsonb_typeof("workflow_recommendations"."evidence" -> 'eventIds') = 'array'
          and jsonb_array_length("workflow_recommendations"."evidence" -> 'eventIds') > 0),
	CONSTRAINT "workflow_recommendations_no_person_ck" CHECK (("workflow_recommendations"."observation"::text || "workflow_recommendations"."evidence"::text) !~* '"(user_?id|user_?ids|actor_?user_?id|assignee_?id|principal_?id|steward_?id|member_?id|agent_?id|agent_?ids|owner_?id|approver_?user_?id|decided_?by[a-z_]*|requested_?by[a-z_]*|answered_?by[a-z_]*|approved_?by[a-z_]*|email)"')
);
--> statement-breakpoint
ALTER TABLE "workflow_recommendations" ADD CONSTRAINT "workflow_recommendations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_recommendations" ADD CONSTRAINT "workflow_recommendations_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_recommendations_open_pattern_uq" ON "workflow_recommendations" USING btree ("company_id","pipeline_id","kind","step_key") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "workflow_recommendations_recipient_idx" ON "workflow_recommendations" USING btree ("company_id","recipient_user_id","status");--> statement-breakpoint
CREATE INDEX "workflow_recommendations_pipeline_idx" ON "workflow_recommendations" USING btree ("company_id","pipeline_id");