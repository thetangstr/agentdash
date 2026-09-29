CREATE TABLE "workforce_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"template_id" text NOT NULL,
	"template_version" integer NOT NULL,
	"objective" text,
	"metrics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"goal_id" uuid,
	"learned_brief_revision" integer,
	"first_job_issue_id" uuid,
	"installed_skill_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skill_install_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workforce_enrollments" ADD CONSTRAINT "workforce_enrollments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_enrollments" ADD CONSTRAINT "workforce_enrollments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_enrollments" ADD CONSTRAINT "workforce_enrollments_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_enrollments" ADD CONSTRAINT "workforce_enrollments_first_job_issue_id_issues_id_fk" FOREIGN KEY ("first_job_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_enrollments_agent_unique" ON "workforce_enrollments" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "workforce_enrollments_company_idx" ON "workforce_enrollments" USING btree ("company_id");