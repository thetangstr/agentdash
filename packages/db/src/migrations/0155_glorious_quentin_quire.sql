CREATE TABLE "routine_run_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_run_id" uuid NOT NULL,
	"trigger_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evaluation_events" ADD COLUMN "access_class" text DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluation_events" ADD COLUMN "subject_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "routine_run_occurrences" ADD CONSTRAINT "routine_run_occurrences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_run_occurrences" ADD CONSTRAINT "routine_run_occurrences_routine_run_id_routine_runs_id_fk" FOREIGN KEY ("routine_run_id") REFERENCES "public"."routine_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_run_occurrences_routine_run_uq" ON "routine_run_occurrences" USING btree ("routine_run_id");--> statement-breakpoint
CREATE INDEX "routine_run_occurrences_company_trigger_scheduled_idx" ON "routine_run_occurrences" USING btree ("company_id","trigger_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "evaluation_events_company_subject_agent_seq_idx" ON "evaluation_events" USING btree ("company_id","subject_agent_id","seq");--> statement-breakpoint
CREATE INDEX "evaluation_events_company_actor_idx" ON "evaluation_events" USING btree ("company_id","actor_id");