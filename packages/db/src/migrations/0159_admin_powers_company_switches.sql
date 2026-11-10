CREATE TABLE "agent_ceiling_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"ceiling" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "admin_directive_read_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "admin_transcript_read_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "assistant_admin_batches_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "assistant_batch_max_records" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "default_ceiling_template_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_ceiling_templates" ADD CONSTRAINT "agent_ceiling_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_ceiling_templates_company_name_uq" ON "agent_ceiling_templates" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "agent_ceiling_templates_company_idx" ON "agent_ceiling_templates" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_default_ceiling_template_id_agent_ceiling_templates_id_fk" FOREIGN KEY ("default_ceiling_template_id") REFERENCES "public"."agent_ceiling_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_assistant_batch_max_records_ck" CHECK ("companies"."assistant_batch_max_records" between 1 and 200);