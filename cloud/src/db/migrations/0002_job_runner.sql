-- AgentDash (GH #764): job runner columns (attempt cap, first start for the per-kind time cap, heartbeat, finish, non-secret payload) and the lease-reclaim index.
ALTER TABLE "jobs" ADD COLUMN "max_attempts" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "payload" jsonb;--> statement-breakpoint
CREATE INDEX "jobs_lease_idx" ON "jobs" USING btree ("state","locked_until");