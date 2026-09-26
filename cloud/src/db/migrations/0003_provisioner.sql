-- AgentDash (GH #763): provisioner bookkeeping on boxes: volume IDs, pinned Postgres image, build source and commit, escrowed (sealed) master key.
ALTER TABLE "boxes" ADD COLUMN "web_volume_id" text;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "pg_volume_id" text;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "pg_image" text;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "build_source" text;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "source_commit" text;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "master_key_escrow" text;