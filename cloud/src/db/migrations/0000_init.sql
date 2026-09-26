-- AgentDash: accounts.email and waitlist.email are citext (spec §3.2).
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"email_verified_at" timestamp with time zone,
	"signup_ip" text,
	"status" text DEFAULT 'pending_verification' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_status_ck" CHECK (status in ('pending_verification', 'active', 'blocked', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "box_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"box_id" uuid,
	"kind" text NOT NULL,
	"actor" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "boxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"kind" text DEFAULT 'dedicated' NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"railway_workspace_id" uuid,
	"project_id" text,
	"environment_id" text,
	"web_service_id" text,
	"pg_service_id" text,
	"upstream_host" text,
	"public_url" text,
	"release_tag" text,
	"image_digest" text,
	"edge_secret_enc" text,
	"claim_code_enc" text,
	"claim_code_hash" text,
	"claim_expires_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"plan_tier" text DEFAULT 'free' NOT NULL,
	"last_health" jsonb,
	"last_human_request_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"delete_after" timestamp with time zone,
	"hold_upgrades" boolean DEFAULT false NOT NULL,
	"cohort" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boxes_kind_ck" CHECK (kind in ('dedicated', 'shared')),
	CONSTRAINT "boxes_state_ck" CHECK (state in ('requested', 'waitlisted', 'provisioning', 'awaiting_claim', 'active', 'suspended', 'pending_delete', 'failed', 'cleanup', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "email_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_tokens_purpose_ck" CHECK (purpose in ('verify', 'find'))
);
--> statement-breakpoint
CREATE TABLE "invite_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"box_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"step" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_kind_ck" CHECK (kind in ('provision', 'close_signup', 'suspend', 'resume', 'upgrade', 'delete')),
	CONSTRAINT "jobs_state_ck" CHECK (state in ('queued', 'running', 'succeeded', 'failed', 'dead'))
);
--> statement-breakpoint
CREATE TABLE "railway_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"railway_workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"project_count" integer DEFAULT 0 NOT NULL,
	"capacity" integer DEFAULT 80 NOT NULL,
	"accepting" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"email" "citext" NOT NULL,
	"requested_slug" text,
	"state" text DEFAULT 'waiting' NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_state_ck" CHECK (state in ('waiting', 'approved', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "box_events" ADD CONSTRAINT "box_events_box_id_boxes_id_fk" FOREIGN KEY ("box_id") REFERENCES "public"."boxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boxes" ADD CONSTRAINT "boxes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boxes" ADD CONSTRAINT "boxes_railway_workspace_id_railway_workspaces_id_fk" FOREIGN KEY ("railway_workspace_id") REFERENCES "public"."railway_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_tokens" ADD CONSTRAINT "email_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_box_id_boxes_id_fk" FOREIGN KEY ("box_id") REFERENCES "public"."boxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_email_uq" ON "accounts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "box_events_box_idx" ON "box_events" USING btree ("box_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "boxes_slug_uq" ON "boxes" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "boxes_account_idx" ON "boxes" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "boxes_state_idx" ON "boxes" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "email_tokens_hash_uq" ON "email_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "email_tokens_account_idx" ON "email_tokens" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_codes_hash_uq" ON "invite_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("state","run_after");--> statement-breakpoint
CREATE INDEX "jobs_box_idx" ON "jobs" USING btree ("box_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_one_live_per_box_kind_uq" ON "jobs" USING btree ("box_id","kind") WHERE state in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "railway_workspaces_railway_id_uq" ON "railway_workspaces" USING btree ("railway_workspace_id");--> statement-breakpoint
CREATE INDEX "waitlist_state_idx" ON "waitlist" USING btree ("state","created_at");