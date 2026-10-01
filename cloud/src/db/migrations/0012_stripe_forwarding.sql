CREATE TABLE "fleet_secrets" (
	"name" text PRIMARY KEY NOT NULL,
	"value_enc" text NOT NULL,
	"fingerprint" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"livemode" boolean DEFAULT false NOT NULL,
	"stripe_created_at" timestamp with time zone,
	"box_slug" text,
	"box_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"body_enc" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_status" integer,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_events_state_ck" CHECK (state in ('pending', 'delivered', 'dropped', 'dead'))
);
--> statement-breakpoint
ALTER TABLE "operator_audit" DROP CONSTRAINT "operator_audit_kind_ck";--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "stripe_webhook_secret_enc" text;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "stripe_config_rev" text;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "stripe_config_pending_rev" text;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "stripe_config_pending_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "plan_tier_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "resend_key_id" text;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_box_id_boxes_id_fk" FOREIGN KEY ("box_id") REFERENCES "public"."boxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_events_event_id_uq" ON "stripe_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "stripe_events_due_idx" ON "stripe_events" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "stripe_events_box_idx" ON "stripe_events" USING btree ("box_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "boxes_stripe_customer_uq" ON "boxes" USING btree ("stripe_customer_id");--> statement-breakpoint
ALTER TABLE "operator_audit" ADD CONSTRAINT "operator_audit_kind_ck" CHECK (kind in ('setting_changed', 'admin_refused', 'invite_codes_changed', 'fleet_secret_changed'));