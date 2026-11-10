CREATE TABLE "batch_operation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"label" text NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"reason_code" text,
	"reason" text,
	"http_status" integer,
	"applied_at" timestamp with time zone,
	"reconciled_by_user_id" text,
	"reconciled_verdict" text,
	"reconciled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_operation_items_outcome_ck" CHECK ("batch_operation_items"."outcome" in ('pending', 'applying', 'applied', 'refused', 'failed', 'unknown')),
	CONSTRAINT "batch_operation_items_verdict_ck" CHECK ("batch_operation_items"."reconciled_verdict" is null or "batch_operation_items"."reconciled_verdict" in ('landed', 'did_not_land'))
);
--> statement-breakpoint
CREATE TABLE "batch_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"change" jsonb NOT NULL,
	"origin" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"assistant_grant_id" uuid,
	"status" text DEFAULT 'previewed' NOT NULL,
	"confirm_token_hash" text,
	"confirm_code_hash" text,
	"confirm_code_attempts" integer DEFAULT 0 NOT NULL,
	"preview_digest" text NOT NULL,
	"item_count" integer NOT NULL,
	"counts" jsonb DEFAULT '{"applied":0,"refused":0,"failed":0,"unknown":0}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"executor_heartbeat_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_operations_origin_ck" CHECK ("batch_operations"."origin" in ('ui', 'assistant')),
	CONSTRAINT "batch_operations_status_ck" CHECK ("batch_operations"."status" in ('previewed', 'running', 'completed', 'interrupted', 'expired', 'cancelled')),
	CONSTRAINT "batch_operations_item_count_ck" CHECK ("batch_operations"."item_count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "batch_operation_items" ADD CONSTRAINT "batch_operation_items_batch_id_batch_operations_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_operations" ADD CONSTRAINT "batch_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_operations" ADD CONSTRAINT "batch_operations_assistant_grant_id_assistant_grants_id_fk" FOREIGN KEY ("assistant_grant_id") REFERENCES "public"."assistant_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "batch_operation_items_batch_entity_uq" ON "batch_operation_items" USING btree ("batch_id","entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "batch_operation_items_batch_ordinal_uq" ON "batch_operation_items" USING btree ("batch_id","ordinal");--> statement-breakpoint
CREATE INDEX "batch_operations_company_created_idx" ON "batch_operations" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "batch_operations_creator_confirmed_idx" ON "batch_operations" USING btree ("created_by_user_id","confirmed_at");--> statement-breakpoint
CREATE INDEX "batch_operations_grant_confirmed_idx" ON "batch_operations" USING btree ("assistant_grant_id","confirmed_at");--> statement-breakpoint
CREATE INDEX "batch_operations_status_heartbeat_idx" ON "batch_operations" USING btree ("status","executor_heartbeat_at");--> statement-breakpoint
CREATE UNIQUE INDEX "batch_operations_confirm_token_hash_uq" ON "batch_operations" USING btree ("confirm_token_hash");