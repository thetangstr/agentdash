CREATE TABLE "agent_goals" (
	"agent_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_goals_agent_id_goal_id_pk" PRIMARY KEY("agent_id","goal_id")
);
--> statement-breakpoint
CREATE TABLE "agent_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"archetype" text NOT NULL,
	"rationale" text,
	"proposal_payload" jsonb NOT NULL,
	"proposed_by_agent_id" uuid,
	"proposed_by_user_id" text,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_pipelines" ADD COLUMN "goal_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "goal_id" uuid;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD COLUMN "goal_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_goals" ADD CONSTRAINT "agent_goals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_goals" ADD CONSTRAINT "agent_goals_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_goals" ADD CONSTRAINT "agent_goals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_plans" ADD CONSTRAINT "agent_plans_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_plans" ADD CONSTRAINT "agent_plans_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_plans" ADD CONSTRAINT "agent_plans_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_goals_goal_idx" ON "agent_goals" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "agent_goals_company_idx" ON "agent_goals" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "agent_plans_company_idx" ON "agent_plans" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "agent_plans_goal_idx" ON "agent_plans" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "agent_plans_company_status_idx" ON "agent_plans" USING btree ("company_id","status");--> statement-breakpoint
ALTER TABLE "agent_pipelines" ADD CONSTRAINT "agent_pipelines_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD CONSTRAINT "budget_policies_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_pipelines_goal_idx" ON "agent_pipelines" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "approvals_goal_idx" ON "approvals" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "budget_policies_goal_idx" ON "budget_policies" USING btree ("goal_id");