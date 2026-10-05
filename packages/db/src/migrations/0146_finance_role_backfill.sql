-- AgentDash (c4-hire-ux): finance-staff titles map to the `finance` role.
--
-- Migration 0144 already ran on deployed databases, so it is restored
-- byte-for-byte and the role-mapping change ships here instead:
--
--   1. agentdash_backfill_agent_accountability is replaced with the updated
--      CASE — only `cfo`/`chief_financial` titles map to the executive `cfo`
--      (still demoted to 'general' inside the function); finance staff titles
--      (bookkeep/accounting/controller/treasury/close/ledger/payable/
--      receivable/payroll terms) map to the neutral `finance` role. Doctor
--      `repair-founder-owner` calls this function, so repaired rows get the
--      new mapping too.
--
--   2. A role-only remap for the rows 0144 already processed. Its CASE sent
--      finance titles to 'cfo', which the executive guard then kept 'general'
--      — post-0144 those agents are autonomous with an accountable person and
--      a humanised title ("bookkeeper" -> "Bookkeeper"), so the remap matches
--      on role='general' plus the title re-normalised to slug form, and never
--      touches title, autonomy, or accountability. The CASE below is truncated
--      after the finance branch: a title can only map to 'finance' when none
--      of the earlier branches claims it, so later branches are irrelevant.
--
-- Safe to run on databases that already have 0144 and on fresh ones (where it
-- runs right after 0144's identical first pass): every changed row writes an
-- activity_log entry, and a re-run matches nothing.
CREATE OR REPLACE FUNCTION agentdash_backfill_agent_accountability(
  p_company_id uuid,
  p_user_id text,
  p_actor text
) RETURNS jsonb
LANGUAGE plpgsql
-- Pinned so a caller's search_path cannot substitute its own tables or
-- functions for the ones named below.
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_paired integer := 0;
  v_retitled integer := 0;
  v_autonomous integer := 0;
  v_held uuid[];
BEGIN
  -- The rule, enforced here so every caller gets it: a non-archived company
  -- whose only active human is p_user_id, and that person an owner or admin.
  IF NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = p_company_id AND c.status <> 'archived')
    OR (
      SELECT count(*) FROM company_memberships m
      WHERE m.company_id = p_company_id AND m.principal_type = 'user' AND m.status = 'active'
    ) <> 1
    OR NOT EXISTS (
      SELECT 1 FROM company_memberships m
      WHERE m.company_id = p_company_id AND m.principal_type = 'user' AND m.status = 'active'
        AND m.principal_id = p_user_id AND m.membership_role IN ('owner', 'admin')
    )
  THEN
    RETURN jsonb_build_object(
      'paired', 0, 'retitled', 0, 'madeAutonomous', 0, 'skippedHeldCredential', '[]'::jsonb,
      'skipped', 'not_sole_owner_or_admin'
    );
  END IF;

  -- Pre-#975 agents of this company that a person holds a credential for.
  SELECT coalesce(array_agg(a.id ORDER BY a.created_at), '{}') INTO v_held
  FROM agents a
  WHERE a.company_id = p_company_id
    AND a.status <> 'terminated'
    AND a.autonomy = 'stewarded'
    AND a.accountable_user_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM agent_stewardships s
      WHERE s.company_id = a.company_id AND s.agent_id = a.id AND s.ended_at IS NULL
    )
    AND (
      EXISTS (
        SELECT 1 FROM agent_api_keys k
        WHERE k.agent_id = a.id AND k.revoked_at IS NULL AND k.name <> 'default'
      )
      OR EXISTS (
        SELECT 1 FROM agent_connect_codes cc
        WHERE cc.agent_id = a.id AND cc.redeemed_at IS NOT NULL
      )
    );

  -- 1. The Chief of Staff: pair it with the person, as founder stewardship does
  --    at creation, when that person stewards nothing yet.
  WITH target AS (
    SELECT a.id AS agent_id
    FROM agents a
    WHERE a.company_id = p_company_id
      AND a.role = 'chief_of_staff'
      AND a.status <> 'terminated'
      AND a.autonomy = 'stewarded'
      AND a.accountable_user_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM agent_stewardships s
        WHERE s.company_id = a.company_id AND s.agent_id = a.id AND s.ended_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM agent_stewardships s
        WHERE s.company_id = p_company_id AND s.user_id = p_user_id AND s.ended_at IS NULL
      )
    ORDER BY a.created_at ASC
    LIMIT 1
  ),
  paired AS (
    INSERT INTO agent_stewardships (company_id, agent_id, user_id, assigned_by_user_id, started_at, created_at, updated_at)
    SELECT p_company_id, target.agent_id, p_user_id, NULL, now(), now(), now() FROM target
    ON CONFLICT DO NOTHING
    RETURNING id, agent_id
  ),
  logged AS (
    INSERT INTO activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, details, origin)
    SELECT p_company_id, 'system', p_actor, 'agent.stewardship_assigned', 'agent_stewardship', paired.id::text, paired.agent_id,
      jsonb_build_object('userId', p_user_id, 'agentId', paired.agent_id, 'reason', 'upgrade_backfill'),
      'server'
    FROM paired
    RETURNING 1
  )
  SELECT count(*) INTO v_paired FROM logged;

  -- 2. Slug titles on pre-#975 "general" agents (before step 3 changes their
  --    autonomy, so both run on the same rows). The title is humanised as
  --    proposedRoleTitle does ("deployment_lead" -> "Deployment Lead", short
  --    acronyms upper-cased). The role is mapped with the rules of
  --    mapProposedAgentRole (packages/shared/src/agent-role-mapping.ts; a test
  --    keeps the two in step) and then, stricter than that function, never to
  --    an executive or privileged role: ceo, chief_of_staff, cto, cmo, cfo stay
  --    "general". A CTO agent is where recovery escalations go.
  WITH n AS (
    SELECT a.id, a.role AS old_role, a.title AS old_title, a.title AS norm
    FROM agents a
    WHERE a.company_id = p_company_id
      AND a.status <> 'terminated'
      AND a.role = 'general'
      AND a.autonomy = 'stewarded'
      AND a.accountable_user_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM agent_stewardships s
        WHERE s.company_id = a.company_id AND s.agent_id = a.id AND s.ended_at IS NULL
      )
      AND a.title ~ '^[a-z0-9]+(_[a-z0-9]+)+$'
  ),
  mapped AS (
    SELECT
      n.id,
      n.old_role,
      n.old_title,
      (
        SELECT string_agg(
          CASE
            WHEN w IN ('qa', 'ux', 'ui', 'pm', 'seo', 'sre', 'cto', 'cmo', 'cfo', 'ceo', 'ai') THEN upper(w)
            ELSE upper(left(w, 1)) || substr(w, 2)
          END,
          ' ' ORDER BY ord
        )
        FROM regexp_split_to_table(n.old_title, '_') WITH ORDINALITY AS t(w, ord)
        WHERE w <> ''
      ) AS new_title,
      CASE
        WHEN n.norm ~ '(^|_)ceo(_|$)' OR position('chief_executive' in n.norm) > 0 OR position('chief_of_staff' in n.norm) > 0 OR position('chiefofstaff' in n.norm) > 0 THEN 'general'
        WHEN n.norm IN ('ceo', 'cto', 'cmo', 'cfo', 'security', 'engineer', 'designer', 'pm', 'qa', 'devops', 'researcher', 'general', 'chief_of_staff') THEN n.norm
        WHEN n.norm ~ '(^|_)cto(_|$)' OR position('technical_director' in n.norm) > 0 OR position('tech_lead' in n.norm) > 0 OR position('architect' in n.norm) > 0 THEN 'cto'
        WHEN n.norm ~ '(^|_)cmo(_|$)' OR position('marketing' in n.norm) > 0 OR position('content' in n.norm) > 0 OR position('growth' in n.norm) > 0 OR position('brand' in n.norm) > 0 OR n.norm ~ '(^|_)seo(_|$)' OR position('social' in n.norm) > 0 OR position('copywrit' in n.norm) > 0 OR position('communications' in n.norm) > 0 OR position('pr_lead' in n.norm) > 0 THEN 'cmo'
        -- AgentDash (c4-hire-ux): only C-suite titles map to the executive
        -- `cfo` (still demoted to 'general' below); finance staff titles map
        -- to the neutral `finance` role, mirroring mapProposedAgentRole.
        WHEN n.norm ~ '(^|_)cfo(_|$)' OR position('chief_financial' in n.norm) > 0 THEN 'cfo'
        WHEN position('finance' in n.norm) > 0 OR position('financial' in n.norm) > 0 OR position('accounting' in n.norm) > 0 OR position('accountant' in n.norm) > 0 OR position('bookkeep' in n.norm) > 0 OR position('controller' in n.norm) > 0 OR position('treasury' in n.norm) > 0 OR position('month_end' in n.norm) > 0 OR position('year_end' in n.norm) > 0 OR position('close_checklist' in n.norm) > 0 OR position('period_close' in n.norm) > 0 OR position('books_close' in n.norm) > 0 OR position('reconcil' in n.norm) > 0 OR position('general_ledger' in n.norm) > 0 OR position('payable' in n.norm) > 0 OR position('receivable' in n.norm) > 0 OR position('payroll' in n.norm) > 0 THEN 'finance'
        WHEN position('security' in n.norm) > 0 OR position('secops' in n.norm) > 0 OR position('compliance' in n.norm) > 0 OR position('privacy' in n.norm) > 0 THEN 'security'
        WHEN n.norm ~ '(^|_)qa(_|$)' OR position('quality' in n.norm) > 0 OR position('tester' in n.norm) > 0 OR position('testing' in n.norm) > 0 OR position('test' in n.norm) > 0 THEN 'qa'
        WHEN position('devops' in n.norm) > 0 OR position('deploy' in n.norm) > 0 OR position('deployment' in n.norm) > 0 OR position('infrastructure' in n.norm) > 0 OR position('infra' in n.norm) > 0 OR n.norm ~ '(^|_)sre(_|$)' OR position('reliability' in n.norm) > 0 OR position('platform' in n.norm) > 0 OR position('release' in n.norm) > 0 OR position('cloud' in n.norm) > 0 THEN 'devops'
        WHEN position('design' in n.norm) > 0 OR n.norm ~ '(^|_)ux(_|$)' OR n.norm ~ '(^|_)ui(_|$)' OR position('creative' in n.norm) > 0 OR position('illustrat' in n.norm) > 0 THEN 'designer'
        WHEN position('research' in n.norm) > 0 OR position('analyst' in n.norm) > 0 OR position('analysis' in n.norm) > 0 OR position('analytics' in n.norm) > 0 OR position('insight' in n.norm) > 0 OR position('data_scien' in n.norm) > 0 OR position('intelligence' in n.norm) > 0 THEN 'researcher'
        WHEN n.norm ~ '(^|_)pm(_|$)' OR position('product' in n.norm) > 0 OR position('project' in n.norm) > 0 OR position('program' in n.norm) > 0 OR position('planner' in n.norm) > 0 OR position('scrum' in n.norm) > 0 OR position('coordinator' in n.norm) > 0 OR position('delivery' in n.norm) > 0 THEN 'pm'
        WHEN position('engineer' in n.norm) > 0 OR position('engineering' in n.norm) > 0 OR position('developer' in n.norm) > 0 OR n.norm ~ '(^|_)dev(_|$)' OR position('programmer' in n.norm) > 0 OR position('coder' in n.norm) > 0 OR position('software' in n.norm) > 0 OR position('frontend' in n.norm) > 0 OR position('backend' in n.norm) > 0 OR position('fullstack' in n.norm) > 0 OR position('full_stack' in n.norm) > 0 OR position('mobile' in n.norm) > 0 THEN 'engineer'
        ELSE 'general'
      END AS mapped_role
    FROM n
  ),
  changed AS (
    UPDATE agents a
    SET title = mapped.new_title,
        role = CASE
          WHEN mapped.mapped_role IN ('ceo', 'chief_of_staff', 'cto', 'cmo', 'cfo') THEN a.role
          ELSE mapped.mapped_role
        END,
        updated_at = now()
    FROM mapped
    WHERE a.id = mapped.id
      AND mapped.new_title IS NOT NULL
    RETURNING a.id, a.role, a.title, mapped.old_role, mapped.old_title
  ),
  logged AS (
    INSERT INTO activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, details, origin)
    SELECT p_company_id, 'system', p_actor, 'agent.updated', 'agent', changed.id::text, changed.id,
      jsonb_build_object(
        'changedTopLevelKeys', CASE WHEN changed.role <> changed.old_role THEN '["role", "title"]'::jsonb ELSE '["title"]'::jsonb END,
        'fromRole', changed.old_role,
        'toRole', changed.role,
        'fromTitle', changed.old_title,
        'toTitle', changed.title,
        'reason', 'upgrade_backfill'
      ),
      'server'
    FROM changed
    RETURNING 1
  )
  SELECT count(*) INTO v_retitled FROM logged;

  -- 3. Every other pre-#975 agent: autonomous, with the person accountable
  --    (#975's model for plan hires). Never the CoS, never an agent a person
  --    holds a credential for.
  WITH changed AS (
    UPDATE agents a
    SET autonomy = 'autonomous',
        accountable_user_id = p_user_id,
        updated_at = now()
    WHERE a.company_id = p_company_id
      AND a.role <> 'chief_of_staff'
      AND a.status <> 'terminated'
      AND a.autonomy = 'stewarded'
      AND a.accountable_user_id IS NULL
      AND a.id <> ALL (v_held)
      AND NOT EXISTS (
        SELECT 1 FROM agent_stewardships s
        WHERE s.company_id = a.company_id AND s.agent_id = a.id AND s.ended_at IS NULL
      )
    RETURNING a.id
  ),
  logged AS (
    INSERT INTO activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, details, origin)
    SELECT p_company_id, 'system', p_actor, 'agent.accountability_changed', 'agent', changed.id::text, changed.id,
      jsonb_build_object(
        'fromAutonomy', 'stewarded',
        'toAutonomy', 'autonomous',
        'fromAccountableUserId', NULL,
        'toAccountableUserId', p_user_id,
        'reason', 'upgrade_backfill'
      ),
      'server'
    FROM changed
    RETURNING 1
  )
  SELECT count(*) INTO v_autonomous FROM logged;

  RETURN jsonb_build_object(
    'paired', v_paired,
    'retitled', v_retitled,
    'madeAutonomous', v_autonomous,
    'skippedHeldCredential', to_jsonb(v_held)
  );
END;
$fn$;
--> statement-breakpoint
-- Only the owner role (the migration runner and the doctor CLI connect as it)
-- may run the backfill; CREATE OR REPLACE preserves the 0144 REVOKE, restated
-- here so the guard is explicit whichever order the files are read in.
REVOKE EXECUTE ON FUNCTION agentdash_backfill_agent_accountability(uuid, text, text) FROM PUBLIC;
--> statement-breakpoint

-- 2. Role-only remap of already-migrated rows (see header). Titles are
--    re-normalised to slug form so both "bookkeeper" and "Bookkeeper" match.
WITH mapped AS (
  SELECT
    a.id,
    a.company_id,
    a.title AS old_title,
    CASE
      WHEN n.norm ~ '(^|_)ceo(_|$)' OR position('chief_executive' in n.norm) > 0 OR position('chief_of_staff' in n.norm) > 0 OR position('chiefofstaff' in n.norm) > 0 THEN 'general'
      WHEN n.norm IN ('ceo', 'cto', 'cmo', 'cfo', 'security', 'engineer', 'designer', 'pm', 'qa', 'devops', 'researcher', 'general', 'chief_of_staff') THEN n.norm
      WHEN n.norm ~ '(^|_)cto(_|$)' OR position('technical_director' in n.norm) > 0 OR position('tech_lead' in n.norm) > 0 OR position('architect' in n.norm) > 0 THEN 'cto'
      WHEN n.norm ~ '(^|_)cmo(_|$)' OR position('marketing' in n.norm) > 0 OR position('content' in n.norm) > 0 OR position('growth' in n.norm) > 0 OR position('brand' in n.norm) > 0 OR n.norm ~ '(^|_)seo(_|$)' OR position('social' in n.norm) > 0 OR position('copywrit' in n.norm) > 0 OR position('communications' in n.norm) > 0 OR position('pr_lead' in n.norm) > 0 THEN 'cmo'
      WHEN n.norm ~ '(^|_)cfo(_|$)' OR position('chief_financial' in n.norm) > 0 THEN 'cfo'
      WHEN position('finance' in n.norm) > 0 OR position('financial' in n.norm) > 0 OR position('accounting' in n.norm) > 0 OR position('accountant' in n.norm) > 0 OR position('bookkeep' in n.norm) > 0 OR position('controller' in n.norm) > 0 OR position('treasury' in n.norm) > 0 OR position('month_end' in n.norm) > 0 OR position('year_end' in n.norm) > 0 OR position('close_checklist' in n.norm) > 0 OR position('period_close' in n.norm) > 0 OR position('books_close' in n.norm) > 0 OR position('reconcil' in n.norm) > 0 OR position('general_ledger' in n.norm) > 0 OR position('payable' in n.norm) > 0 OR position('receivable' in n.norm) > 0 OR position('payroll' in n.norm) > 0 THEN 'finance'
      ELSE 'general'
    END AS mapped_role
  FROM agents a
  CROSS JOIN LATERAL (
    SELECT trim(both '_' from regexp_replace(lower(a.title), '[^a-z0-9]+', '_', 'g')) AS norm
  ) n
  WHERE a.status <> 'terminated'
    AND a.role = 'general'
    AND a.title IS NOT NULL
),
changed AS (
  UPDATE agents a
  SET role = 'finance', updated_at = now()
  FROM mapped
  WHERE a.id = mapped.id
    AND mapped.mapped_role = 'finance'
  RETURNING a.id, a.company_id, a.title
),
logged AS (
  INSERT INTO activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, details, origin)
  SELECT changed.company_id, 'system', 'migration:0146_finance_role_backfill', 'agent.updated', 'agent', changed.id::text, changed.id,
    jsonb_build_object(
      'changedTopLevelKeys', '["role"]'::jsonb,
      'fromRole', 'general',
      'toRole', 'finance',
      'title', changed.title,
      'reason', 'upgrade_backfill'
    ),
    'server'
  FROM changed
  RETURNING 1
)
SELECT count(*) AS remapped FROM logged;
