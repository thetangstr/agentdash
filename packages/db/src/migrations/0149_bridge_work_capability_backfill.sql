-- AgentDash (coworker bridge, D8): endpoints that already read their owner's
-- steward inbox (`bridge:inbox`) gain `bridge:work` on deploy, so the person's
-- own Claude can read their agents' hand-offs without re-running connect.
--
-- `bridge:work` reaches only the /api/bridge/work/* routes, and those still
-- answer nothing until the company's `coworker_bridge_enabled` flag is on.
-- Revoked endpoints are left alone: they authenticate nothing, and an audit
-- row claiming a dead credential was widened would only mislead.
--
-- Every upgraded endpoint writes one activity_log row, so the widening is
-- auditable per endpoint. Safe to re-run: an endpoint that already holds
-- `bridge:work` matches nothing.
WITH upgraded AS (
  UPDATE bridge_endpoints e
  SET capabilities = e.capabilities || '["bridge:work"]'::jsonb,
      updated_at = now()
  WHERE e.revoked_at IS NULL
    AND e.capabilities ? 'bridge:inbox'
    AND NOT (e.capabilities ? 'bridge:work')
  RETURNING e.id, e.company_id, e.user_id, e.label
),
logged AS (
  INSERT INTO activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, details, origin)
  SELECT upgraded.company_id, 'system', 'migration:0149_bridge_work_capability_backfill',
    'bridge.endpoint_capability_added', 'bridge_endpoint', upgraded.id::text,
    jsonb_build_object(
      'capability', 'bridge:work',
      'label', upgraded.label,
      'userId', upgraded.user_id,
      'reason', 'upgrade_backfill'
    ),
    'server'
  FROM upgraded
  RETURNING 1
)
SELECT count(*) AS upgraded FROM logged;
