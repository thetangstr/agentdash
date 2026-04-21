CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"stripe_event_id" text NOT NULL,
	"stripe_event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "company_plan" ADD COLUMN "subscription_status" text;--> statement-breakpoint
ALTER TABLE "company_plan" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_events_company_idx" ON "billing_events" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "billing_events_stripe_event_idx" ON "billing_events" USING btree ("stripe_event_id");