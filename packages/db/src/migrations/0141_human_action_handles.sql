CREATE TABLE "human_action_handles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"board_api_key_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"company_id" uuid,
	"operation_id" text NOT NULL,
	"version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"preconditions" jsonb NOT NULL,
	"confirmation_mode" text DEFAULT 'human_readback' NOT NULL,
	"status" text DEFAULT 'prepared' NOT NULL,
	"result" jsonb,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "human_action_handles_target_check" CHECK (("human_action_handles"."target_kind" = 'company' AND "human_action_handles"."company_id" IS NOT NULL) OR ("human_action_handles"."target_kind" IN ('self', 'instance', 'public') AND "human_action_handles"."company_id" IS NULL)),
	CONSTRAINT "human_action_handles_status_check" CHECK ("human_action_handles"."status" IN ('prepared', 'completed', 'denied', 'stale', 'expired', 'recovery_required')),
	CONSTRAINT "human_action_handles_version_check" CHECK ("human_action_handles"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "human_action_handles" ADD CONSTRAINT "human_action_handles_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_action_handles" ADD CONSTRAINT "human_action_handles_board_api_key_id_board_api_keys_id_fk" FOREIGN KEY ("board_api_key_id") REFERENCES "public"."board_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_action_handles" ADD CONSTRAINT "human_action_handles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "human_action_handles_hash_uq" ON "human_action_handles" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "human_action_handles_actor_idx" ON "human_action_handles" USING btree ("actor_user_id","board_api_key_id");--> statement-breakpoint
CREATE INDEX "human_action_handles_status_expires_idx" ON "human_action_handles" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "human_action_handles_company_idx" ON "human_action_handles" USING btree ("company_id");