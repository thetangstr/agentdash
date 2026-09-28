CREATE TABLE "cloud_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bucket" text NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signup_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"email_token_id" uuid,
	"slug" text NOT NULL,
	"workspace_name" text NOT NULL,
	"ip" text,
	"unverified_human" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"box_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_sessions" ADD CONSTRAINT "cloud_sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_requests" ADD CONSTRAINT "signup_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_requests" ADD CONSTRAINT "signup_requests_email_token_id_email_tokens_id_fk" FOREIGN KEY ("email_token_id") REFERENCES "public"."email_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_requests" ADD CONSTRAINT "signup_requests_box_id_boxes_id_fk" FOREIGN KEY ("box_id") REFERENCES "public"."boxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_sessions_hash_uq" ON "cloud_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "rate_events_lookup_idx" ON "rate_events" USING btree ("bucket","key","created_at");--> statement-breakpoint
CREATE INDEX "signup_requests_slug_idx" ON "signup_requests" USING btree ("slug","expires_at");--> statement-breakpoint
CREATE INDEX "signup_requests_ip_idx" ON "signup_requests" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "signup_requests_account_idx" ON "signup_requests" USING btree ("account_id");