ALTER TABLE "assistant_messages" ADD COLUMN "author_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_messages_author_agent_created_idx" ON "assistant_messages" USING btree ("author_agent_id", "created_at");--> statement-breakpoint
-- AgentDash: attribute pre-column agent replies so an upgraded box's chat
-- tally is not zero. Both UPDATEs are idempotent — they only touch rows whose
-- author_agent_id is still NULL.
--
-- Steward conversations are titled "<provider>:<binding_id>" (see
-- steward-agent-replier.ts); the binding row names the stewarded agent.
UPDATE "assistant_messages" m
SET "author_agent_id" = b."agent_id"
FROM "assistant_conversations" c
JOIN "human_channel_bindings" b
  ON b."company_id" = c."company_id"
 AND b."provider" = split_part(c."title", ':', 1)
 AND b."id"::text = split_part(c."title", ':', 2)
WHERE m."conversation_id" = c."id"
  AND m."role" = 'agent'
  AND m."author_agent_id" IS NULL
  AND c."title" ~ '^[^:]+:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';--> statement-breakpoint
-- CoS conversations: the /cos bootstrap thread carries a NULL title and the
-- shared inbox is titled 'Company Inbox'. Replies there attribute to the
-- company's first chief_of_staff — summoned-teammate replies in the shared
-- inbox are over-attributed to the CoS, which is accepted (no better signal
-- exists on rows written before this column).
UPDATE "assistant_messages" m
SET "author_agent_id" = cos."id"
FROM "assistant_conversations" c
JOIN LATERAL (
  SELECT a."id"
  FROM "agents" a
  WHERE a."company_id" = c."company_id"
    AND a."role" = 'chief_of_staff'
  ORDER BY a."created_at"
  LIMIT 1
) cos ON true
WHERE m."conversation_id" = c."id"
  AND m."role" = 'agent'
  AND m."author_agent_id" IS NULL
  AND (c."title" IS NULL OR c."title" = 'Company Inbox');
