ALTER TABLE "agent_fact_requests" DROP CONSTRAINT "agent_fact_requests_status_ck";--> statement-breakpoint
ALTER TABLE "agent_fact_requests" ADD COLUMN "held_answer" text;--> statement-breakpoint
ALTER TABLE "agent_fact_requests" ADD COLUMN "filter_categories" jsonb;--> statement-breakpoint
ALTER TABLE "agent_fact_requests" ADD COLUMN "filter_rule_ids" jsonb;--> statement-breakpoint
ALTER TABLE "agent_fact_requests" ADD COLUMN "filter_approval_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_fact_requests" ADD CONSTRAINT "agent_fact_requests_filter_approval_id_approvals_id_fk" FOREIGN KEY ("filter_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_fact_requests" ADD CONSTRAINT "agent_fact_requests_held_answer_framed_ck" CHECK ("agent_fact_requests"."held_answer" is null or "agent_fact_requests"."held_answer" like '<untrusted-agent-answer>%');--> statement-breakpoint
ALTER TABLE "agent_fact_requests" ADD CONSTRAINT "agent_fact_requests_held_has_approval_ck" CHECK ("agent_fact_requests"."status" <> 'held' or ("agent_fact_requests"."held_answer" is not null and "agent_fact_requests"."filter_approval_id" is not null));--> statement-breakpoint
ALTER TABLE "agent_fact_requests" ADD CONSTRAINT "agent_fact_requests_status_ck" CHECK ("agent_fact_requests"."status" in ('asked', 'answered', 'declined', 'escalated', 'missing', 'held'));