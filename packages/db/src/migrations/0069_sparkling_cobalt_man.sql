ALTER TABLE "skill_versions" ADD COLUMN "model_tier" text;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD COLUMN "max_tool_calls" integer;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD COLUMN "verification" jsonb;