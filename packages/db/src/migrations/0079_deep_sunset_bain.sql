CREATE TABLE "goal_interview_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"conversation_id" text,
	"started_by_user_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "goal_interview_sessions" ADD CONSTRAINT "goal_interview_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_interview_sessions" ADD CONSTRAINT "goal_interview_sessions_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gis_goal_idx" ON "goal_interview_sessions" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "gis_company_idx" ON "goal_interview_sessions" USING btree ("company_id");