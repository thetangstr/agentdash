CREATE TABLE "agent_profile_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"approval_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approver_user_id" text,
	"approver_authority" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_profile_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"based_on_revision_id" uuid,
	"state" text DEFAULT 'draft' NOT NULL,
	"body" jsonb NOT NULL,
	"body_hash" text NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bases" jsonb,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"approval_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"active_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_responsibilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"responsibility_key" text NOT NULL,
	"profile_revision_id" uuid,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"mapped_by" text NOT NULL,
	"mapped_by_actor_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "agent_access_enforcement" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_profile_applications" ADD CONSTRAINT "agent_profile_applications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_applications" ADD CONSTRAINT "agent_profile_applications_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_applications" ADD CONSTRAINT "agent_profile_applications_revision_id_agent_profile_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."agent_profile_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_applications" ADD CONSTRAINT "agent_profile_applications_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_revisions" ADD CONSTRAINT "agent_profile_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_revisions" ADD CONSTRAINT "agent_profile_revisions_profile_id_agent_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_revisions" ADD CONSTRAINT "agent_profile_revisions_based_on_revision_id_agent_profile_revisions_id_fk" FOREIGN KEY ("based_on_revision_id") REFERENCES "public"."agent_profile_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_revisions" ADD CONSTRAINT "agent_profile_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_revisions" ADD CONSTRAINT "agent_profile_revisions_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_revisions" ADD CONSTRAINT "agent_profile_revisions_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_active_revision_id_agent_profile_revisions_id_fk" FOREIGN KEY ("active_revision_id") REFERENCES "public"."agent_profile_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_responsibilities" ADD CONSTRAINT "issue_responsibilities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_responsibilities" ADD CONSTRAINT "issue_responsibilities_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_responsibilities" ADD CONSTRAINT "issue_responsibilities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_responsibilities" ADD CONSTRAINT "issue_responsibilities_profile_revision_id_agent_profile_revisions_id_fk" FOREIGN KEY ("profile_revision_id") REFERENCES "public"."agent_profile_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profile_applications_approval_uq" ON "agent_profile_applications" USING btree ("approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profile_applications_in_progress_uq" ON "agent_profile_applications" USING btree ("company_id","agent_id") WHERE "agent_profile_applications"."status" = 'in_progress';--> statement-breakpoint
CREATE INDEX "agent_profile_applications_company_agent_created_idx" ON "agent_profile_applications" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_profile_applications_revision_idx" ON "agent_profile_applications" USING btree ("revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profile_revisions_profile_revision_uq" ON "agent_profile_revisions" USING btree ("profile_id","revision_number");--> statement-breakpoint
CREATE INDEX "agent_profile_revisions_company_profile_state_idx" ON "agent_profile_revisions" USING btree ("company_id","profile_id","state");--> statement-breakpoint
CREATE INDEX "agent_profile_revisions_approval_idx" ON "agent_profile_revisions" USING btree ("approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profiles_agent_uq" ON "agent_profiles" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_profiles_company_idx" ON "agent_profiles" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_responsibilities_current_issue_uq" ON "issue_responsibilities" USING btree ("issue_id") WHERE "issue_responsibilities"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX "issue_responsibilities_company_issue_from_idx" ON "issue_responsibilities" USING btree ("company_id","issue_id","valid_from");--> statement-breakpoint
CREATE INDEX "issue_responsibilities_company_agent_key_idx" ON "issue_responsibilities" USING btree ("company_id","agent_id","responsibility_key");--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_agent_access_enforcement_ck" CHECK ("companies"."agent_access_enforcement" in ('off', 'shadow', 'enforce'));