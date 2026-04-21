CREATE TABLE "kpis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"unit" text DEFAULT '' NOT NULL,
	"target_value" numeric DEFAULT '0' NOT NULL,
	"current_value" numeric,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kpis" ADD CONSTRAINT "kpis_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kpis_company_priority_idx" ON "kpis" USING btree ("company_id","priority" DESC NULLS LAST);