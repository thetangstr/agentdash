CREATE TABLE "cloud_billing" (
	"id" text PRIMARY KEY DEFAULT 'cloud' NOT NULL,
	"stripe_endpoint_id" text,
	"stripe_endpoint_url" text,
	"stripe_endpoint_secret_enc" text,
	"stripe_box_key_enc" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_deliveries" (
	"event_id" text PRIMARY KEY NOT NULL,
	"payload_hash" text NOT NULL,
	"box_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "stripe_webhook_secret_enc" text;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "resend_api_key_id" text;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "resend_api_key_enc" text;--> statement-breakpoint
ALTER TABLE "stripe_deliveries" ADD CONSTRAINT "stripe_deliveries_box_id_boxes_id_fk" FOREIGN KEY ("box_id") REFERENCES "public"."boxes"("id") ON DELETE no action ON UPDATE no action;