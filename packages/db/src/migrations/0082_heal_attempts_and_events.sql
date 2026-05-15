-- AgentDash (#297): backfill the missing migration for `heal_attempts` and
-- `heal_events`. These tables were defined in
-- `packages/db/src/schema/heal_attempts.ts` when the run-healer service
-- shipped, but the corresponding `pnpm db:generate` was never run, so the
-- tables only existed in TypeScript. The healer would silently no-op (or
-- crash) in any fresh deployment because the SELECT/INSERTs hit a
-- non-existent relation. Adding the migration brings prod and the embedded
-- test database back in sync with the schema source of truth.

CREATE TABLE "heal_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"diagnosis" jsonb NOT NULL,
	"fix_type" text NOT NULL,
	"action_taken" text,
	"succeeded" boolean,
	"cost_usd" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "heal_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"run_id" uuid,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "heal_attempts" ADD CONSTRAINT "heal_attempts_run_id_heartbeat_runs_id_fk"
	FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "heal_events" ADD CONSTRAINT "heal_events_run_id_heartbeat_runs_id_fk"
	FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "heal_attempts_run_id_idx" ON "heal_attempts" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "heal_attempts_created_at_idx" ON "heal_attempts" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "heal_events_event_type_idx" ON "heal_events" USING btree ("event_type");
--> statement-breakpoint
CREATE INDEX "heal_events_created_at_idx" ON "heal_events" USING btree ("created_at");
