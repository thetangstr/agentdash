CREATE TABLE "assistant_action_handles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"company_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_grants" ADD COLUMN "decisions_need_tap" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_action_handles" ADD CONSTRAINT "assistant_action_handles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_action_handles" ADD CONSTRAINT "assistant_action_handles_grant_id_assistant_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."assistant_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_action_handles_token_uq" ON "assistant_action_handles" USING btree ("token");--> statement-breakpoint
CREATE INDEX "assistant_action_handles_grant_idx" ON "assistant_action_handles" USING btree ("grant_id");