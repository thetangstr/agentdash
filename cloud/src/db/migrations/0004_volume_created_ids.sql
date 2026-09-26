-- AgentDash (GH #800 review): the volume IDs volumeCreate returned, so a retry waits for a late-listed volume instead of creating a second.
ALTER TABLE "boxes" ADD COLUMN "pg_volume_created_id" text;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "web_volume_created_id" text;