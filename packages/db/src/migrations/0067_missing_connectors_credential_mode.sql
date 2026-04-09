-- Migration 0067: Add missing company_connectors table and agents.credential_mode column
-- These were defined in the schema but never generated as SQL migrations.

CREATE TABLE IF NOT EXISTS "company_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"credential_mode" text DEFAULT 'service_account' NOT NULL,
	"encrypted_tokens" jsonb,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"connected_by" uuid,
	"connected_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"error_message" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_connectors_company_idx" ON "company_connectors" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_connectors_unique_idx" ON "company_connectors" USING btree ("company_id","provider");
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'company_connectors_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "company_connectors" ADD CONSTRAINT "company_connectors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agents' AND column_name = 'credential_mode'
  ) THEN
    ALTER TABLE "agents" ADD COLUMN "credential_mode" text DEFAULT 'claw' NOT NULL;
  END IF;
END $$;
