-- AgentDash (full-flow demo, Slice 1): delegated-authority mandates table.
-- Composes budget_policies (spend cap + optional policy link) with the
-- principal_permission_grants scope shape (jsonb scope + permission key),
-- adding an expiry and Clockchain anchor fields (cc_*). Company-scoped.
-- The cc_* columns are populated only when delegate_authority actually
-- returns a ledgerId; they stay NULL otherwise.

CREATE TABLE "mandates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"grantor_agent_id" uuid NOT NULL,
	"grantee_agent_id" uuid NOT NULL,
	"scope" jsonb NOT NULL,
	"permission_key" text NOT NULL,
	"spend_cap_cents" integer DEFAULT 0 NOT NULL,
	"budget_policy_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cc_ledger_id" text,
	"cc_block_height" integer,
	"cc_scheme" text,
	"cc_anchored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_company_id_companies_id_fk"
	FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_grantor_agent_id_agents_id_fk"
	FOREIGN KEY ("grantor_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_grantee_agent_id_agents_id_fk"
	FOREIGN KEY ("grantee_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_budget_policy_id_budget_policies_id_fk"
	FOREIGN KEY ("budget_policy_id") REFERENCES "public"."budget_policies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "mandates_company_status_idx" ON "mandates" USING btree ("company_id", "status");
--> statement-breakpoint
CREATE INDEX "mandates_grantee_idx" ON "mandates" USING btree ("company_id", "grantee_agent_id");
