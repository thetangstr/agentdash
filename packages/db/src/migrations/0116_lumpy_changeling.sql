CREATE TABLE "agent_connect_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"redeemed_device_name" text,
	"issued_api_key_id" uuid,
	"created_by_user_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_connect_codes" ADD CONSTRAINT "agent_connect_codes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connect_codes" ADD CONSTRAINT "agent_connect_codes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connect_codes" ADD CONSTRAINT "agent_connect_codes_issued_api_key_id_agent_api_keys_id_fk" FOREIGN KEY ("issued_api_key_id") REFERENCES "public"."agent_api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_connect_codes_code_hash_unique_idx" ON "agent_connect_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "agent_connect_codes_agent_state_idx" ON "agent_connect_codes" USING btree ("company_id","agent_id","redeemed_at","expires_at");