ALTER TABLE "approvals" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "decision_channel" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "decision_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "decision_actor_role" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "override_reason" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_company_decision_idempotency_uq" ON "approvals" USING btree ("company_id","decision_idempotency_key") WHERE "approvals"."decision_idempotency_key" is not null;