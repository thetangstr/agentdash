CREATE TABLE "agent_governance_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"owner_ceiling" jsonb NOT NULL,
	"owner_ceiling_revision" integer DEFAULT 1 NOT NULL,
	"owner_ceiling_updated_by_user_id" text,
	"steward_request" jsonb NOT NULL,
	"steward_request_revision" integer DEFAULT 1 NOT NULL,
	"steward_request_updated_by_user_id" text,
	"effective_policy" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_governance_policies" ADD CONSTRAINT "agent_governance_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_governance_policies" ADD CONSTRAINT "agent_governance_policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_governance_policies_company_agent_uq" ON "agent_governance_policies" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "agent_governance_policies_company_idx" ON "agent_governance_policies" USING btree ("company_id");