ALTER TABLE "agent_fact_requests" ADD COLUMN "answered_by_user_id" text;--> statement-breakpoint
ALTER TABLE "agent_fact_requests" ADD CONSTRAINT "agent_fact_requests_answered_by_user_id_user_id_fk" FOREIGN KEY ("answered_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
