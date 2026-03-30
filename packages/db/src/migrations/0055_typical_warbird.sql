CREATE TABLE "crm_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"first_name" text,
	"last_name" text,
	"email" text,
	"phone" text,
	"company" text,
	"title" text,
	"source" text,
	"status" text DEFAULT 'new' NOT NULL,
	"score" text,
	"owner_agent_id" uuid,
	"owner_user_id" text,
	"converted_account_id" uuid,
	"converted_contact_id" uuid,
	"converted_at" timestamp with time zone,
	"external_id" text,
	"external_source" text,
	"metadata" jsonb,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'referral' NOT NULL,
	"contact_name" text,
	"contact_email" text,
	"website" text,
	"status" text DEFAULT 'active' NOT NULL,
	"tier" text,
	"referral_count" text,
	"revenue_attributed_cents" text,
	"owner_agent_id" uuid,
	"owner_user_id" text,
	"linked_account_id" uuid,
	"external_id" text,
	"external_source" text,
	"metadata" jsonb,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_converted_account_id_crm_accounts_id_fk" FOREIGN KEY ("converted_account_id") REFERENCES "public"."crm_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_converted_contact_id_crm_contacts_id_fk" FOREIGN KEY ("converted_contact_id") REFERENCES "public"."crm_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_partners" ADD CONSTRAINT "crm_partners_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_partners" ADD CONSTRAINT "crm_partners_linked_account_id_crm_accounts_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."crm_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_leads_company_status_idx" ON "crm_leads" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "crm_leads_company_source_idx" ON "crm_leads" USING btree ("company_id","source");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_leads_external_unique" ON "crm_leads" USING btree ("company_id","external_source","external_id");--> statement-breakpoint
CREATE INDEX "crm_partners_company_status_idx" ON "crm_partners" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "crm_partners_company_type_idx" ON "crm_partners" USING btree ("company_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_partners_external_unique" ON "crm_partners" USING btree ("company_id","external_source","external_id");