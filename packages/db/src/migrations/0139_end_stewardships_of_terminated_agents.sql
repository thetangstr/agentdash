-- AgentDash: end every open stewardship whose agent is terminated.
--
-- Terminating an agent used to leave its stewardship open. The one-per-person
-- partial unique index (agent_stewardships_active_user_uq) filters on ended_at
-- only, so the person's single slot stayed held by a dead agent: they could
-- not be assigned another one, and release/transfer refused the terminated
-- agent. `agentService.terminate` now ends the pairing in the same
-- transaction; this closes the rows written before that change.
--
-- Idempotent: only rows still open on a terminated agent match, so a re-run
-- updates and logs nothing. ended_by_user_id stays NULL -- no person ended
-- these; the audit row below names the migration instead. Channel bindings and
-- bridge endpoints are deliberately not revoked here: that is an application
-- decision with per-row audit, and the ones pointing at a terminated agent can
-- no longer act (its keys were revoked at termination).
WITH "ended" AS (
  UPDATE "agent_stewardships" AS "s"
  SET "ended_at" = now(),
      "transfer_reason" = 'agent_terminated',
      "updated_at" = now()
  FROM "agents" AS "a"
  WHERE "a"."id" = "s"."agent_id"
    AND "a"."status" = 'terminated'
    AND "s"."ended_at" IS NULL
  RETURNING "s"."id", "s"."company_id", "s"."agent_id", "s"."user_id"
)
INSERT INTO "activity_log" (
  "company_id", "actor_type", "actor_id", "action", "entity_type", "entity_id", "agent_id", "details", "origin"
)
SELECT
  "ended"."company_id",
  'system',
  'migration:0139_end_stewardships_of_terminated_agents',
  'agent.stewardship_ended',
  'agent_stewardship',
  "ended"."id"::text,
  "ended"."agent_id",
  jsonb_build_object('userId', "ended"."user_id", 'reason', 'agent_terminated'),
  'server'
FROM "ended";
