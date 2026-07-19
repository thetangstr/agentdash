CREATE TABLE "zk_permission_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mandate_id" uuid,
	"grantee_agent_id" uuid,
	"scheme" text NOT NULL,
	"proof_hash" text NOT NULL,
	"nullifier" text NOT NULL,
	"authority" text NOT NULL,
	"scope" text NOT NULL,
	"valid_at" bigint NOT NULL,
	"proof_bytes" text NOT NULL,
	"ledger_id" text,
	"block_height" integer,
	"event_hash" text,
	"receipt_status" text,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zk_permission_proofs_nullifier_key" UNIQUE("nullifier")
);
--> statement-breakpoint
ALTER TABLE "zk_permission_proofs" ADD CONSTRAINT "zk_permission_proofs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "zk_permission_proofs" ADD CONSTRAINT "zk_permission_proofs_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "mandates"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "zk_permission_proofs_company_proof_idx" ON "zk_permission_proofs" ("company_id","proof_hash");
--> statement-breakpoint
CREATE INDEX "zk_permission_proofs_mandate_idx" ON "zk_permission_proofs" ("company_id","mandate_id");
