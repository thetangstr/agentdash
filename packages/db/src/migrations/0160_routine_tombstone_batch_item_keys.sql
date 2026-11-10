ALTER TABLE "batch_operations" ADD COLUMN "item_key_nonce" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "deleted_at" timestamp with time zone;