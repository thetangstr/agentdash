CREATE TABLE "crm_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"industry" text,
	"size" text,
	"stage" text,
	"owner_agent_id" uuid,
	"owner_user_id" text,
	"external_id" text,
	"external_source" text,
	"metadata" jsonb,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"account_id" uuid,
	"contact_id" uuid,
	"deal_id" uuid,
	"activity_type" text NOT NULL,
	"subject" text,
	"body" text,
	"performed_by_agent_id" uuid,
	"performed_by_user_id" text,
	"external_id" text,
	"external_source" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"account_id" uuid,
	"first_name" text,
	"last_name" text,
	"email" text,
	"phone" text,
	"title" text,
	"owner_agent_id" uuid,
	"owner_user_id" text,
	"external_id" text,
	"external_source" text,
	"metadata" jsonb,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"account_id" uuid,
	"contact_id" uuid,
	"name" text NOT NULL,
	"stage" text,
	"amount_cents" text,
	"currency" text DEFAULT 'USD',
	"close_date" timestamp with time zone,
	"probability" text,
	"owner_agent_id" uuid,
	"owner_user_id" text,
	"linked_project_id" uuid,
	"linked_issue_id" uuid,
	"external_id" text,
	"external_source" text,
	"metadata" jsonb,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_accounts" ADD CONSTRAINT "crm_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_account_id_crm_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."crm_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_contact_id_crm_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."crm_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_deal_id_crm_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."crm_deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_account_id_crm_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."crm_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_account_id_crm_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."crm_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_contact_id_crm_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."crm_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_accounts_company_idx" ON "crm_accounts" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_accounts_external_unique" ON "crm_accounts" USING btree ("company_id","external_source","external_id");--> statement-breakpoint
CREATE INDEX "crm_activities_company_idx" ON "crm_activities" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "crm_activities_account_idx" ON "crm_activities" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "crm_activities_deal_idx" ON "crm_activities" USING btree ("deal_id","occurred_at");--> statement-breakpoint
CREATE INDEX "crm_contacts_company_idx" ON "crm_contacts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "crm_contacts_account_idx" ON "crm_contacts" USING btree ("company_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_contacts_external_unique" ON "crm_contacts" USING btree ("company_id","external_source","external_id");--> statement-breakpoint
CREATE INDEX "crm_deals_company_idx" ON "crm_deals" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "crm_deals_account_idx" ON "crm_deals" USING btree ("company_id","account_id");--> statement-breakpoint
CREATE INDEX "crm_deals_stage_idx" ON "crm_deals" USING btree ("company_id","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_deals_external_unique" ON "crm_deals" USING btree ("company_id","external_source","external_id");