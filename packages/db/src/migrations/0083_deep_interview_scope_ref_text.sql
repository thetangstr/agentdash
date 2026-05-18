DROP INDEX IF EXISTS "deep_interview_states_scope_idx";--> statement-breakpoint
ALTER TABLE "deep_interview_states" ALTER COLUMN "scope_ref_id" TYPE text USING "scope_ref_id"::text;--> statement-breakpoint
CREATE INDEX "deep_interview_states_scope_idx" ON "deep_interview_states" USING btree ("scope","scope_ref_id");
