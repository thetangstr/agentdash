CREATE TABLE "agent_stewardships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"assigned_by_user_id" text,
	"ended_by_user_id" text,
	"transfer_reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_stewardships" ADD CONSTRAINT "agent_stewardships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_stewardships" ADD CONSTRAINT "agent_stewardships_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_stewardships_active_user_uq" ON "agent_stewardships" USING btree ("company_id","user_id") WHERE "agent_stewardships"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_stewardships_active_agent_uq" ON "agent_stewardships" USING btree ("company_id","agent_id") WHERE "agent_stewardships"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "agent_stewardships_company_user_idx" ON "agent_stewardships" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "agent_stewardships_company_agent_started_idx" ON "agent_stewardships" USING btree ("company_id","agent_id","started_at");