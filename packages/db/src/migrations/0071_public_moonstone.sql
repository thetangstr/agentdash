CREATE TABLE "company_plan" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"monthly_price_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_plan" ADD CONSTRAINT "company_plan_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_plan" ADD CONSTRAINT "company_plan_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_plan_plan_idx" ON "company_plan" USING btree ("plan_id");