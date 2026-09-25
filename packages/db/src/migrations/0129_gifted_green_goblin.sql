CREATE TABLE "assistant_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"grant_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_auth_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_row_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"state" text,
	"scope" text NOT NULL,
	"resource" text NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" text,
	"company_id" uuid,
	"grant_id" uuid,
	"code_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"redirect_host" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_whats_new_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"registration_type" text NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"grant_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_access_tokens" ADD CONSTRAINT "assistant_access_tokens_grant_id_assistant_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."assistant_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_auth_requests" ADD CONSTRAINT "assistant_auth_requests_client_row_id_assistant_oauth_clients_id_fk" FOREIGN KEY ("client_row_id") REFERENCES "public"."assistant_oauth_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_auth_requests" ADD CONSTRAINT "assistant_auth_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_auth_requests" ADD CONSTRAINT "assistant_auth_requests_grant_id_assistant_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."assistant_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_grants" ADD CONSTRAINT "assistant_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_refresh_tokens" ADD CONSTRAINT "assistant_refresh_tokens_grant_id_assistant_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."assistant_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_access_tokens_token_hash_uq" ON "assistant_access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "assistant_access_tokens_family_idx" ON "assistant_access_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "assistant_access_tokens_grant_idx" ON "assistant_access_tokens" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "assistant_auth_requests_code_hash_idx" ON "assistant_auth_requests" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "assistant_auth_requests_status_idx" ON "assistant_auth_requests" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_grants_live_uq" ON "assistant_grants" USING btree ("user_id","client_id","company_id") WHERE "assistant_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "assistant_grants_company_idx" ON "assistant_grants" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_oauth_clients_client_id_uq" ON "assistant_oauth_clients" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_refresh_tokens_token_hash_uq" ON "assistant_refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "assistant_refresh_tokens_family_idx" ON "assistant_refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "assistant_refresh_tokens_grant_idx" ON "assistant_refresh_tokens" USING btree ("grant_id");