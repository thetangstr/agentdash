DROP INDEX "billing_events_stripe_event_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_stripe_event_idx" ON "billing_events" USING btree ("stripe_event_id");