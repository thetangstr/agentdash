-- AgentDash (AGE-44): Backfill assistant_conversations.assistant_agent_id to the company's
-- Chief of Staff agent (role='chief_of_staff'). Legacy role='assistant' agent rows stay in
-- place; only the pointer on existing conversations is updated so chat traffic is now
-- attributed to the CoS agent.
UPDATE "assistant_conversations" AS ac
SET "assistant_agent_id" = cos."id"
FROM (
  SELECT DISTINCT ON ("company_id") "id", "company_id"
  FROM "agents"
  WHERE "role" = 'chief_of_staff'
  ORDER BY "company_id", "created_at" ASC
) AS cos
WHERE cos."company_id" = ac."company_id";
