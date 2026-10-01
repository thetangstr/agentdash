CREATE TABLE "box_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"box_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"backup_day" text NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"object_path" text,
	"size_bytes" bigint,
	"sha256" text,
	"plain_bytes" bigint,
	"sealed_to" text,
	"format" text,
	"counts" jsonb,
	"release" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"pruned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "box_backups_trigger_ck" CHECK (trigger in ('scheduled', 'manual')),
	CONSTRAINT "box_backups_state_ck" CHECK (state in ('running', 'succeeded', 'failed', 'pruned'))
);
--> statement-breakpoint
ALTER TABLE "box_backups" ADD CONSTRAINT "box_backups_box_id_boxes_id_fk" FOREIGN KEY ("box_id") REFERENCES "public"."boxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "box_backups_box_idx" ON "box_backups" USING btree ("box_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "box_backups_scheduled_day_uq" ON "box_backups" USING btree ("box_id","backup_day") WHERE "trigger" = 'scheduled';