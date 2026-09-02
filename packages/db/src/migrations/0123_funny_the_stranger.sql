ALTER TABLE "agent_api_keys" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD COLUMN "created_by_agent_id" uuid;--> statement-breakpoint
-- AgentDash (AGE-24): backfill provenance for keys that already exist. The key
-- auto-created with an agent is named "default" and minted in the same request
-- as the agent row, so a "default" key created within two minutes of its agent
-- is attributed to agent creation; everything else stays "manual".
UPDATE "agent_api_keys" k
SET "source" = 'agent_creation'
FROM "agents" a
WHERE k."agent_id" = a."id"
  AND k."name" = 'default'
  AND k."created_at" <= a."created_at" + interval '2 minutes';
