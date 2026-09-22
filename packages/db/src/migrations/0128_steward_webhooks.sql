CREATE TABLE "steward_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"verified_at" timestamp with time zone,
	"last_delivered_seq" integer DEFAULT 0 NOT NULL,
	"last_delivered_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "steward_webhooks" ADD CONSTRAINT "steward_webhooks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "steward_webhooks_company_user_idx" ON "steward_webhooks" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "steward_webhooks_active_url_uq" ON "steward_webhooks" USING btree ("company_id","user_id","url") WHERE "steward_webhooks"."revoked_at" is null;