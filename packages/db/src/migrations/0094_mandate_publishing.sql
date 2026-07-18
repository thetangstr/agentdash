ALTER TABLE "mandates" ADD COLUMN "published" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "counterparty_company_id" uuid;
--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "accepted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_counterparty_company_id_companies_id_fk" FOREIGN KEY ("counterparty_company_id") REFERENCES "companies"("id") ON DELETE no action ON UPDATE no action;
