ALTER TABLE "agents" ADD COLUMN "visibility" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "agent_visibility_default" text DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_visibility_ck" CHECK ("agents"."visibility" is null or "agents"."visibility" in ('company', 'owner'));--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_agent_visibility_default_ck" CHECK ("companies"."agent_visibility_default" in ('company', 'owner'));