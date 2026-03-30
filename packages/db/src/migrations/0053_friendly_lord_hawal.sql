CREATE TABLE "company_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"context_type" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"confidence" numeric(3, 2) DEFAULT '0.80' NOT NULL,
	"source_id" uuid,
	"verified_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"current_step" text DEFAULT 'discovery' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" text NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_locator" text NOT NULL,
	"raw_content" text,
	"extracted_summary" text,
	"extracted_entities" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_context" ADD CONSTRAINT "company_context_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_context" ADD CONSTRAINT "company_context_source_id_onboarding_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."onboarding_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_sessions" ADD CONSTRAINT "onboarding_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_sources" ADD CONSTRAINT "onboarding_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_sources" ADD CONSTRAINT "onboarding_sources_session_id_onboarding_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."onboarding_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_context_company_type_key_unique" ON "company_context" USING btree ("company_id","context_type","key");--> statement-breakpoint
CREATE INDEX "company_context_company_type_idx" ON "company_context" USING btree ("company_id","context_type");--> statement-breakpoint
CREATE INDEX "onboarding_sessions_company_status_idx" ON "onboarding_sessions" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "onboarding_sources_company_session_idx" ON "onboarding_sources" USING btree ("company_id","session_id");