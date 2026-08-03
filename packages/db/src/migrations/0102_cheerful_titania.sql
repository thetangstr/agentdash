CREATE TABLE "channel_pairing_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"binding_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_pairing_challenges" ADD CONSTRAINT "channel_pairing_challenges_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_pairing_challenges" ADD CONSTRAINT "channel_pairing_challenges_binding_id_human_channel_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."human_channel_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_pairing_challenges_token_uq" ON "channel_pairing_challenges" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_pairing_challenges_active_user_uq" ON "channel_pairing_challenges" USING btree ("company_id","provider","user_id") WHERE "channel_pairing_challenges"."consumed_at" is null;--> statement-breakpoint
CREATE INDEX "channel_pairing_challenges_company_idx" ON "channel_pairing_challenges" USING btree ("company_id","provider");