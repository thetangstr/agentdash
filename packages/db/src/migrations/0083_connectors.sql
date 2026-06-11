-- AgentDash (AGE-106): Connector framework — connection model, workspace
-- defaults, and per-agent overrides.

CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"provider" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"send_identity" text DEFAULT 'service' NOT NULL,
	"autonomy" jsonb DEFAULT '{"read":"full","draft":"full","send":"draft_only"}'::jsonb NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"account_label" text,
	"encrypted_token" jsonb,
	"oauth_state" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "connector_workspace_defaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"send_identity" text DEFAULT 'service' NOT NULL,
	"autonomy" jsonb DEFAULT '{"read":"full","draft":"full","send":"draft_only"}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_connector_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"send_identity" text,
	"autonomy" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_company_id_companies_id_fk"
	FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connector_workspace_defaults" ADD CONSTRAINT "connector_workspace_defaults_company_id_companies_id_fk"
	FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_connector_overrides" ADD CONSTRAINT "agent_connector_overrides_company_id_companies_id_fk"
	FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_connector_overrides" ADD CONSTRAINT "agent_connector_overrides_agent_id_agents_id_fk"
	FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "connections_company_idx" ON "connections" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "connections_company_provider_idx" ON "connections" USING btree ("company_id","provider");
--> statement-breakpoint
CREATE INDEX "connections_owner_idx" ON "connections" USING btree ("company_id","owner_type","owner_id");
--> statement-breakpoint
CREATE INDEX "connections_status_idx" ON "connections" USING btree ("company_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "connector_workspace_defaults_company_uq" ON "connector_workspace_defaults" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_connector_overrides_agent_uq" ON "agent_connector_overrides" USING btree ("company_id","agent_id");
