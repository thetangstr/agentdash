CREATE TABLE "agent_directives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"directives" text NOT NULL,
	"pushed_by_user_id" text NOT NULL,
	"pushed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_directives" ADD CONSTRAINT "agent_directives_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_directives" ADD CONSTRAINT "agent_directives_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_directives_active_uq" ON "agent_directives" USING btree ("company_id","agent_id") WHERE "agent_directives"."superseded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_directives_version_uq" ON "agent_directives" USING btree ("company_id","agent_id","version");--> statement-breakpoint
CREATE INDEX "agent_directives_company_idx" ON "agent_directives" USING btree ("company_id","agent_id");