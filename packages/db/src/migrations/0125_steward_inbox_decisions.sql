ALTER TABLE "channel_callback_tokens" ADD COLUMN IF NOT EXISTS "bridge_endpoint_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_callback_tokens" ADD CONSTRAINT "channel_callback_tokens_bridge_endpoint_id_bridge_endpoints_id_fk" FOREIGN KEY ("bridge_endpoint_id") REFERENCES "public"."bridge_endpoints"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_callback_tokens_endpoint_idx" ON "channel_callback_tokens" USING btree ("bridge_endpoint_id");
