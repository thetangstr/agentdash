CREATE TABLE "mandate_attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mandate_id" uuid NOT NULL,
	"grantee_agent_id" uuid NOT NULL,
	"action" text NOT NULL,
	"counterparty_did" text,
	"authorized" boolean DEFAULT false NOT NULL,
	"reason" text,
	"ledger_id" text,
	"block_height" integer,
	"event_hash" text,
	"receipt_status" text,
	"escalated" boolean DEFAULT false NOT NULL,
	"approval_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mandate_attestations" ADD CONSTRAINT "mandate_attestations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mandate_attestations" ADD CONSTRAINT "mandate_attestations_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "mandates"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "mandate_attestations_company_mandate_idx" ON "mandate_attestations" ("company_id","mandate_id");
--> statement-breakpoint
CREATE INDEX "mandate_attestations_grantee_idx" ON "mandate_attestations" ("company_id","grantee_agent_id");
