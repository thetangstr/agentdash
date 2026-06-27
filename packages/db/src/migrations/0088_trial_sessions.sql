-- AgentDash (Test Drive): no-signup anonymous trial.
-- trial_sessions backs an ephemeral trial_anonymous company + one curated hero
-- agent, keyed by an opaque url-safe token (no email, no user). A credit guard
-- (credit_cents/spent_cents) bounds anonymous LLM spend; sessions expire after a
-- fixed window. trial_artifacts persists the structured deliverable each curated
-- hero run produces (e.g. a sales-outreach sequence).
-- See docs/superpowers/specs/2026-06-27-test-drive-no-signup-trial.md (§4, §5, §10).

CREATE TABLE "trial_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"credit_cents" integer NOT NULL,
	"spent_cents" integer DEFAULT 0 NOT NULL,
	"ip_hash" text,
	"claimed_by_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trial_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trial_session_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"use_case" text NOT NULL,
	"title" text NOT NULL,
	"content" jsonb NOT NULL,
	"input_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trial_sessions" ADD CONSTRAINT "trial_sessions_company_id_companies_id_fk"
	FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trial_sessions" ADD CONSTRAINT "trial_sessions_agent_id_agents_id_fk"
	FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trial_artifacts" ADD CONSTRAINT "trial_artifacts_trial_session_id_trial_sessions_id_fk"
	FOREIGN KEY ("trial_session_id") REFERENCES "public"."trial_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trial_artifacts" ADD CONSTRAINT "trial_artifacts_company_id_companies_id_fk"
	FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trial_artifacts" ADD CONSTRAINT "trial_artifacts_agent_id_agents_id_fk"
	FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "trial_sessions_token_unique_idx" ON "trial_sessions" USING btree ("token");
--> statement-breakpoint
CREATE INDEX "trial_sessions_company_idx" ON "trial_sessions" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "trial_artifacts_session_idx" ON "trial_artifacts" USING btree ("trial_session_id");
