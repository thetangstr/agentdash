CREATE TABLE "agent_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_agent_id" uuid,
	"author_user_id" text,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_active_uniq" ON "agent_memory" USING btree ("company_id","agent_id") WHERE "agent_memory"."superseded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_agent_version_uniq" ON "agent_memory" USING btree ("agent_id","version");--> statement-breakpoint
CREATE INDEX "agent_memory_company_agent_idx" ON "agent_memory" USING btree ("company_id","agent_id");