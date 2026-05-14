-- AgentDash: attestation v1 — trail anchors
-- Adds the per-company tamper-evident hash chain that anchors batches of
-- activity_log rows to an external service (Clockchain or a no-op adapter).
-- See docs/superpowers/specs/2026-05-13-delegation-and-attestation-design.md.

CREATE TABLE "trail_anchors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"prev_anchor_id" uuid,
	"prev_payload_hash" text,
	"batch_start_activity_id" uuid NOT NULL,
	"batch_end_activity_id" uuid NOT NULL,
	"batch_activity_count" integer NOT NULL,
	"manifest_sha256" text NOT NULL,
	"manifest_preview" jsonb,
	"adapter" text NOT NULL,
	"external_log_id" text,
	"external_block_height" bigint,
	"external_anchored_at" timestamp with time zone,
	"status" text NOT NULL DEFAULT 'pending',
	"last_error" text,
	"anchored_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "trail_anchors" ADD CONSTRAINT "trail_anchors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trail_anchors" ADD CONSTRAINT "trail_anchors_prev_anchor_id_trail_anchors_id_fk" FOREIGN KEY ("prev_anchor_id") REFERENCES "public"."trail_anchors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trail_anchors_company_created_idx" ON "trail_anchors" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "trail_anchors_company_status_idx" ON "trail_anchors" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "trail_anchors_company_end_activity_idx" ON "trail_anchors" USING btree ("company_id","batch_end_activity_id");
