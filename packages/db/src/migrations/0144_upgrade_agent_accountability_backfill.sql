-- AgentDash (canary1, v2026.1002.1): repair agents left by onboarding before #975.
--
-- Before #975 the onboarding plan hired every agent `stewarded` with nobody
-- paired, role "general", and the proposed role slug as its title. A box
-- upgraded past #975 kept those rows, so every agent read "Needs a steward"
-- and its title read "deployment_lead". #975's model for a plan hire is
-- autonomous with the confirming founder accountable, because stewardship is
-- one person per agent (agent_stewardships_active_user_uq) and the founder
-- stewards the Chief of Staff.
--
-- Scope: only companies with exactly ONE active human member, and that member
-- an owner or admin. There the answer is not a guess. Companies with more
-- than one human are left untouched (who answers for an agent is their call)
-- and are named in a NOTICE that the migration runner logs.
--
-- Idempotent: every statement matches only rows still in the pre-#975 state
-- (stewarded, no active stewardship, no accountable person; slug titles), so
-- a re-run changes and logs nothing. Each change writes an activity row whose
-- actor names this migration.

-- 1. The Chief of Staff: pair it with the sole human, as founder stewardship
--    does at creation, when that person stewards nothing yet. If they already
--    steward another agent the CoS is left as it is.
WITH "sole" AS (
  SELECT "m"."company_id", min("m"."principal_id") AS "user_id"
  FROM "company_memberships" "m"
  WHERE "m"."principal_type" = 'user' AND "m"."status" = 'active'
  GROUP BY "m"."company_id"
  HAVING count(*) = 1 AND bool_and("m"."membership_role" IN ('owner', 'admin'))
),
"target" AS (
  SELECT DISTINCT ON ("a"."company_id") "a"."id" AS "agent_id", "a"."company_id", "sole"."user_id"
  FROM "agents" "a"
  JOIN "sole" ON "sole"."company_id" = "a"."company_id"
  WHERE "a"."role" = 'chief_of_staff'
    AND "a"."status" <> 'terminated'
    AND "a"."autonomy" = 'stewarded'
    AND "a"."accountable_user_id" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "agent_stewardships" "s"
      WHERE "s"."company_id" = "a"."company_id" AND "s"."agent_id" = "a"."id" AND "s"."ended_at" IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM "agent_stewardships" "s"
      WHERE "s"."company_id" = "a"."company_id" AND "s"."user_id" = "sole"."user_id" AND "s"."ended_at" IS NULL
    )
  ORDER BY "a"."company_id", "a"."created_at" ASC
),
"paired" AS (
  INSERT INTO "agent_stewardships" ("company_id", "agent_id", "user_id", "assigned_by_user_id", "started_at", "created_at", "updated_at")
  SELECT "company_id", "agent_id", "user_id", NULL, now(), now(), now() FROM "target"
  ON CONFLICT DO NOTHING
  RETURNING "id", "company_id", "agent_id", "user_id"
)
INSERT INTO "activity_log" (
  "company_id", "actor_type", "actor_id", "action", "entity_type", "entity_id", "agent_id", "details", "origin"
)
SELECT
  "paired"."company_id",
  'system',
  'migration:0144_upgrade_agent_accountability_backfill',
  'agent.stewardship_assigned',
  'agent_stewardship',
  "paired"."id"::text,
  "paired"."agent_id",
  jsonb_build_object('userId', "paired"."user_id", 'agentId', "paired"."agent_id", 'reason', 'upgrade_backfill'),
  'server'
FROM "paired";
--> statement-breakpoint
-- 2. Every other unpaired agent: autonomous, with the sole human accountable
--    (#975's model for plan hires). The CoS is never made autonomous here.
WITH "sole" AS (
  SELECT "m"."company_id", min("m"."principal_id") AS "user_id"
  FROM "company_memberships" "m"
  WHERE "m"."principal_type" = 'user' AND "m"."status" = 'active'
  GROUP BY "m"."company_id"
  HAVING count(*) = 1 AND bool_and("m"."membership_role" IN ('owner', 'admin'))
),
"changed" AS (
  UPDATE "agents" "a"
  SET "autonomy" = 'autonomous',
      "accountable_user_id" = "sole"."user_id",
      "updated_at" = now()
  FROM "sole"
  WHERE "sole"."company_id" = "a"."company_id"
    AND "a"."role" <> 'chief_of_staff'
    AND "a"."status" <> 'terminated'
    AND "a"."autonomy" = 'stewarded'
    AND "a"."accountable_user_id" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "agent_stewardships" "s"
      WHERE "s"."company_id" = "a"."company_id" AND "s"."agent_id" = "a"."id" AND "s"."ended_at" IS NULL
    )
  RETURNING "a"."id", "a"."company_id", "a"."accountable_user_id"
)
INSERT INTO "activity_log" (
  "company_id", "actor_type", "actor_id", "action", "entity_type", "entity_id", "agent_id", "details", "origin"
)
SELECT
  "changed"."company_id",
  'system',
  'migration:0144_upgrade_agent_accountability_backfill',
  'agent.accountability_changed',
  'agent',
  "changed"."id"::text,
  "changed"."id",
  jsonb_build_object(
    'fromAutonomy', 'stewarded',
    'toAutonomy', 'autonomous',
    'fromAccountableUserId', NULL,
    'toAccountableUserId', "changed"."accountable_user_id",
    'reason', 'upgrade_backfill'
  ),
  'server'
FROM "changed";
--> statement-breakpoint
-- 3. Slug titles and the "general" role they came with. The title is
--    humanised exactly as proposedRoleTitle does ("deployment_lead" ->
--    "Deployment Lead", short acronyms upper-cased). A "general" role is
--    mapped from the slug with the same rules as mapProposedAgentRole
--    (packages/shared/src/agent-role-mapping.ts; a test keeps the two in step),
--    and then, stricter than that function, never to an executive or
--    privileged role: ceo, chief_of_staff, cto, cmo, cfo stay "general". A CTO
--    agent is where recovery escalations go, so a backfill must not create one.
WITH "sole" AS (
  SELECT "m"."company_id"
  FROM "company_memberships" "m"
  WHERE "m"."principal_type" = 'user' AND "m"."status" = 'active'
  GROUP BY "m"."company_id"
  HAVING count(*) = 1 AND bool_and("m"."membership_role" IN ('owner', 'admin'))
),
"n" AS (
  SELECT
    "a"."id",
    "a"."role" AS "old_role",
    "a"."title" AS "old_title",
    regexp_replace(regexp_replace("a"."title", '[^a-z0-9]+', '_', 'g'), '^_+|_+$', '', 'g') AS "norm"
  FROM "agents" "a"
  JOIN "sole" ON "sole"."company_id" = "a"."company_id"
  WHERE "a"."status" <> 'terminated'
    AND "a"."role" NOT IN ('chief_of_staff', 'ceo')
    AND "a"."title" ~ '^[a-z0-9_-]+$'
    AND "a"."title" ~ '[a-z]'
),
"mapped" AS (
  SELECT
    n."id",
    n."old_role",
    n."old_title",
    (
      SELECT string_agg(
        CASE
          WHEN "w" IN ('qa', 'ux', 'ui', 'pm', 'seo', 'sre', 'cto', 'cmo', 'cfo', 'ceo', 'ai') THEN upper("w")
          ELSE upper(left("w", 1)) || substr("w", 2)
        END,
        ' ' ORDER BY "ord"
      )
      FROM regexp_split_to_table(n."old_title", '[_-]+') WITH ORDINALITY AS "t"("w", "ord")
      WHERE "w" <> ''
    ) AS "new_title",
    CASE
      WHEN n."old_role" <> 'general' THEN n."old_role"
      ELSE (
        CASE
          WHEN n.norm ~ '(^|_)ceo(_|$)' OR position('chief_executive' in n.norm) > 0 OR position('chief_of_staff' in n.norm) > 0 OR position('chiefofstaff' in n.norm) > 0 THEN 'general'
          WHEN n.norm IN ('ceo', 'cto', 'cmo', 'cfo', 'security', 'engineer', 'designer', 'pm', 'qa', 'devops', 'researcher', 'general', 'chief_of_staff') THEN n.norm
          WHEN n.norm ~ '(^|_)cto(_|$)' OR position('technical_director' in n.norm) > 0 OR position('tech_lead' in n.norm) > 0 OR position('architect' in n.norm) > 0 THEN 'cto'
          WHEN n.norm ~ '(^|_)cmo(_|$)' OR position('marketing' in n.norm) > 0 OR position('content' in n.norm) > 0 OR position('growth' in n.norm) > 0 OR position('brand' in n.norm) > 0 OR n.norm ~ '(^|_)seo(_|$)' OR position('social' in n.norm) > 0 OR position('copywrit' in n.norm) > 0 OR position('communications' in n.norm) > 0 OR position('pr_lead' in n.norm) > 0 THEN 'cmo'
          WHEN n.norm ~ '(^|_)cfo(_|$)' OR position('finance' in n.norm) > 0 OR position('financial' in n.norm) > 0 OR position('accounting' in n.norm) > 0 OR position('accountant' in n.norm) > 0 OR position('bookkeep' in n.norm) > 0 OR position('controller' in n.norm) > 0 OR position('treasury' in n.norm) > 0 THEN 'cfo'
          WHEN position('security' in n.norm) > 0 OR position('secops' in n.norm) > 0 OR position('compliance' in n.norm) > 0 OR position('privacy' in n.norm) > 0 THEN 'security'
          WHEN n.norm ~ '(^|_)qa(_|$)' OR position('quality' in n.norm) > 0 OR position('tester' in n.norm) > 0 OR position('testing' in n.norm) > 0 OR position('test' in n.norm) > 0 THEN 'qa'
          WHEN position('devops' in n.norm) > 0 OR position('deploy' in n.norm) > 0 OR position('deployment' in n.norm) > 0 OR position('infrastructure' in n.norm) > 0 OR position('infra' in n.norm) > 0 OR n.norm ~ '(^|_)sre(_|$)' OR position('reliability' in n.norm) > 0 OR position('platform' in n.norm) > 0 OR position('release' in n.norm) > 0 OR position('cloud' in n.norm) > 0 THEN 'devops'
          WHEN position('design' in n.norm) > 0 OR n.norm ~ '(^|_)ux(_|$)' OR n.norm ~ '(^|_)ui(_|$)' OR position('creative' in n.norm) > 0 OR position('illustrat' in n.norm) > 0 THEN 'designer'
          WHEN position('research' in n.norm) > 0 OR position('analyst' in n.norm) > 0 OR position('analysis' in n.norm) > 0 OR position('analytics' in n.norm) > 0 OR position('insight' in n.norm) > 0 OR position('data_scien' in n.norm) > 0 OR position('intelligence' in n.norm) > 0 THEN 'researcher'
          WHEN n.norm ~ '(^|_)pm(_|$)' OR position('product' in n.norm) > 0 OR position('project' in n.norm) > 0 OR position('program' in n.norm) > 0 OR position('planner' in n.norm) > 0 OR position('scrum' in n.norm) > 0 OR position('coordinator' in n.norm) > 0 OR position('delivery' in n.norm) > 0 THEN 'pm'
          WHEN position('engineer' in n.norm) > 0 OR position('engineering' in n.norm) > 0 OR position('developer' in n.norm) > 0 OR n.norm ~ '(^|_)dev(_|$)' OR position('programmer' in n.norm) > 0 OR position('coder' in n.norm) > 0 OR position('software' in n.norm) > 0 OR position('frontend' in n.norm) > 0 OR position('backend' in n.norm) > 0 OR position('fullstack' in n.norm) > 0 OR position('full_stack' in n.norm) > 0 OR position('mobile' in n.norm) > 0 THEN 'engineer'
          ELSE 'general'
        END
      )
    END AS "mapped_role"
  FROM "n" n
),
"changed" AS (
  UPDATE "agents" "a"
  SET "title" = "mapped"."new_title",
      "role" = CASE
        WHEN "mapped"."mapped_role" IN ('ceo', 'chief_of_staff', 'cto', 'cmo', 'cfo') THEN "a"."role"
        ELSE "mapped"."mapped_role"
      END,
      "updated_at" = now()
  FROM "mapped"
  WHERE "a"."id" = "mapped"."id"
    AND "mapped"."new_title" IS NOT NULL
  RETURNING "a"."id", "a"."company_id", "a"."role", "a"."title", "mapped"."old_role", "mapped"."old_title"
)
INSERT INTO "activity_log" (
  "company_id", "actor_type", "actor_id", "action", "entity_type", "entity_id", "agent_id", "details", "origin"
)
SELECT
  "changed"."company_id",
  'system',
  'migration:0144_upgrade_agent_accountability_backfill',
  'agent.updated',
  'agent',
  "changed"."id"::text,
  "changed"."id",
  jsonb_build_object(
    'changedTopLevelKeys', CASE WHEN "changed"."role" <> "changed"."old_role" THEN '["role", "title"]'::jsonb ELSE '["title"]'::jsonb END,
    'fromRole', "changed"."old_role",
    'toRole', "changed"."role",
    'fromTitle', "changed"."old_title",
    'toTitle', "changed"."title",
    'reason', 'upgrade_backfill'
  ),
  'server'
FROM "changed";
--> statement-breakpoint
-- 4. Name the multi-human companies this left alone, so an operator can see
--    which workspaces still have agents nobody answers for.
DO $$
DECLARE "skipped" text;
BEGIN
  SELECT string_agg("c"."id"::text || ' (' || "c"."name" || ')', ', ' ORDER BY "c"."name")
  INTO "skipped"
  FROM "companies" "c"
  WHERE (
      SELECT count(*) FROM "company_memberships" "m"
      WHERE "m"."company_id" = "c"."id" AND "m"."principal_type" = 'user' AND "m"."status" = 'active'
    ) > 1
    AND EXISTS (
      SELECT 1 FROM "agents" "a"
      WHERE "a"."company_id" = "c"."id"
        AND "a"."status" <> 'terminated'
        AND "a"."autonomy" = 'stewarded'
        AND "a"."accountable_user_id" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "agent_stewardships" "s"
          WHERE "s"."company_id" = "a"."company_id" AND "s"."agent_id" = "a"."id" AND "s"."ended_at" IS NULL
        )
    );
  IF "skipped" IS NOT NULL THEN
    RAISE NOTICE 'agentdash: migration 0144 left agents with no steward and no accountable person unchanged in these multi-human companies (assign them from Members & access or the agent page): %', "skipped";
  END IF;
END $$;
