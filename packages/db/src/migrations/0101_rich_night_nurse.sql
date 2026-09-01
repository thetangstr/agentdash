CREATE TABLE "channel_callback_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"company_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"binding_id" uuid,
	"approval_revision" integer NOT NULL,
	"decision" text NOT NULL,
	"provider" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_callback_tokens" ADD CONSTRAINT "channel_callback_tokens_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_callback_tokens" ADD CONSTRAINT "channel_callback_tokens_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_callback_tokens" ADD CONSTRAINT "channel_callback_tokens_binding_id_human_channel_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."human_channel_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_callback_tokens_token_uq" ON "channel_callback_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "channel_callback_tokens_approval_idx" ON "channel_callback_tokens" USING btree ("approval_id");