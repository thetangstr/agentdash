CREATE TABLE "skill_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"depends_on_skill_id" uuid NOT NULL,
	"version_constraint" text,
	"is_required" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"version_id" uuid,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"issue_id" uuid,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"semver" text,
	"markdown" text NOT NULL,
	"file_inventory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb,
	"change_summary" text,
	"diff_from_previous" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"deprecated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "published_version_id" uuid;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "latest_version_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_dependencies" ADD CONSTRAINT "skill_dependencies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_dependencies" ADD CONSTRAINT "skill_dependencies_skill_id_company_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_dependencies" ADD CONSTRAINT "skill_dependencies_depends_on_skill_id_company_skills_id_fk" FOREIGN KEY ("depends_on_skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_skill_id_company_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."company_skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_version_id_skill_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."skill_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_company_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_dependencies_unique" ON "skill_dependencies" USING btree ("skill_id","depends_on_skill_id");--> statement-breakpoint
CREATE INDEX "skill_dependencies_depends_on_idx" ON "skill_dependencies" USING btree ("depends_on_skill_id");--> statement-breakpoint
CREATE INDEX "skill_usage_events_company_skill_idx" ON "skill_usage_events" USING btree ("company_id","skill_id","used_at");--> statement-breakpoint
CREATE INDEX "skill_usage_events_company_agent_idx" ON "skill_usage_events" USING btree ("company_id","agent_id","used_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_skill_version_unique" ON "skill_versions" USING btree ("skill_id","version_number");--> statement-breakpoint
CREATE INDEX "skill_versions_company_skill_status_idx" ON "skill_versions" USING btree ("company_id","skill_id","status");