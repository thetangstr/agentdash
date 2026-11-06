CREATE TABLE "fred_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"main_issue_id" uuid,
	"owner_user_id" text NOT NULL,
	"state" text DEFAULT 'materializing' NOT NULL,
	"mandate_version" text NOT NULL,
	"brief_revision" integer DEFAULT 0 NOT NULL,
	"brief" jsonb,
	"brief_document_revision_id" uuid,
	"started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fred_registrations_state_check" CHECK ("fred_registrations"."state" in ('materializing', 'ready', 'repair_needed')),
	CONSTRAINT "fred_registrations_brief_revision_check" CHECK ("fred_registrations"."brief_revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "fred_registrations" ADD CONSTRAINT "fred_registrations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fred_registrations" ADD CONSTRAINT "fred_registrations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fred_registrations" ADD CONSTRAINT "fred_registrations_main_issue_id_issues_id_fk" FOREIGN KEY ("main_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fred_registrations" ADD CONSTRAINT "fred_registrations_brief_document_revision_id_document_revisions_id_fk" FOREIGN KEY ("brief_document_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fred_registrations_company_unique" ON "fred_registrations" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fred_registrations_agent_unique" ON "fred_registrations" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fred_registrations_issue_unique" ON "fred_registrations" USING btree ("main_issue_id");