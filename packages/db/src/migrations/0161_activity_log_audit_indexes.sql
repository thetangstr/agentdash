-- AgentDash admin powers: indexes for the admin audit (filter by person, by action).
-- Plain CREATE INDEX, not CONCURRENTLY: both migration paths (drizzle's migrate on
-- a fresh database, and the manual per-file runner in src/client.ts) wrap each
-- file in a transaction, where CONCURRENTLY is not allowed. IF NOT EXISTS keeps a
-- rerun harmless. On a very large activity_log the build briefly blocks writes.
CREATE INDEX IF NOT EXISTS "activity_log_company_actor_created_idx" ON "activity_log" USING btree ("company_id","actor_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_log_company_action_created_idx" ON "activity_log" USING btree ("company_id","action","created_at");
