-- AgentDash (better-auth 1.6 -> 1.7): Microsoft sign-in accounts move from
-- `sub` to `oid`.
--
-- Better Auth 1.6 keyed a Microsoft account row on the ID token's `sub`, a
-- pairwise identifier that is specific to the app registration. 1.7 keys it on
-- the directory object id `oid` (accountSubject: profile.oid) and looks the
-- row up by (provider_id, account_id). Without this backfill an existing
-- Microsoft user's next sign-in finds no row: they get "account not linked",
-- or a second, oid-keyed row is linked next to the stale one. This follows
-- the 1.7 upgrade guide ("Migrate Microsoft account identifiers").
--
-- Where the oid comes from: the row's own stored `id_token`. Better Auth 1.6
-- writes it when the account is created and refreshes it on every sign-in
-- (updateAccountOnSignIn defaults on, and this repo does not encrypt OAuth
-- tokens), so it is the latest token Microsoft issued for this row. The token
-- was verified when Better Auth stored it: it came from Microsoft's token
-- endpoint on the OAuth callback, or passed Better Auth's id-token check on
-- the id-token sign-in path. Its signature is not re-checked here: a
-- migration runs offline, the token has expired, and Microsoft rotates its
-- signing keys. Instead the token is bound to the row: its `sub` must equal
-- the row's current account_id, and its `oid` must be a GUID.
--
-- Scope and safety:
--   - only rows with provider_id = 'microsoft' are read for re-keying, and only
--     account_id (plus updated_at) changes; no company is involved;
--   - a row is left unchanged when it has no stored id token, the token does
--     not decode, its `sub` is not the row's account_id, or it has no GUID
--     `oid`. The user signs in again by email, or an operator re-keys the row
--     from a Microsoft Entra export (see doc/RELEASING.md);
--   - a row is also left unchanged when its oid is already some row's
--     account_id, or when two rows resolve to the same oid. Better Auth refuses
--     a sign-in when two rows share (provider_id, account_id), so the backfill
--     never creates such a pair;
--   - safe to re-run: a re-keyed row's account_id is its oid, which no longer
--     equals its token's `sub`, so it is counted as already keyed and skipped.
--
-- The counts, and the account row ids left unchanged, are reported in NOTICEs
-- the migration runner logs. It also names (by row id, read-only) any rows of
-- any provider that share one (provider_id, account_id): the upgrade guide asks
-- for that check, and Better Auth 1.7 refuses sign-in on such a pair.
CREATE OR REPLACE FUNCTION pg_temp.agentdash_jwt_payload(token text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_part text;
  v_payload jsonb;
BEGIN
  IF token IS NULL OR array_length(string_to_array(token, '.'), 1) IS DISTINCT FROM 3 THEN
    RETURN NULL;
  END IF;
  v_part := split_part(token, '.', 2);
  IF v_part !~ '^[A-Za-z0-9_-]+$' THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_payload := convert_from(
      decode(translate(v_part, '-_', '+/') || repeat('=', (4 - length(v_part) % 4) % 4), 'base64'),
      'UTF8'
    )::jsonb;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    RETURN NULL;
  END IF;
  RETURN v_payload;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  v_total integer;
  v_rekeyed integer;
  v_already integer;
  v_unresolved text[];
  v_conflict text[];
  v_duplicates text;
BEGIN
  CREATE TEMP TABLE agentdash_ms_accounts ON COMMIT DROP AS
  SELECT
    a.id,
    a.account_id,
    CASE WHEN jsonb_typeof(p.payload -> 'sub') = 'string' THEN p.payload ->> 'sub' END AS sub,
    CASE
      WHEN jsonb_typeof(p.payload -> 'oid') = 'string'
        AND (p.payload ->> 'oid') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN p.payload ->> 'oid'
    END AS oid
  FROM account a
  CROSS JOIN LATERAL (SELECT pg_temp.agentdash_jwt_payload(a.id_token) AS payload) p
  WHERE a.provider_id = 'microsoft';

  SELECT count(*) INTO v_total FROM agentdash_ms_accounts;
  IF v_total = 0 THEN
    v_rekeyed := 0;
  ELSE
    SELECT count(*) INTO v_already FROM agentdash_ms_accounts WHERE oid IS NOT NULL AND account_id = oid;

    SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_unresolved
    FROM agentdash_ms_accounts
    WHERE NOT (oid IS NOT NULL AND account_id = oid)
      AND (oid IS NULL OR sub IS DISTINCT FROM account_id);

    CREATE TEMP TABLE agentdash_ms_candidates ON COMMIT DROP AS
    SELECT id, oid FROM agentdash_ms_accounts
    WHERE oid IS NOT NULL AND sub = account_id AND account_id <> oid;

    SELECT coalesce(array_agg(c.id ORDER BY c.id), '{}') INTO v_conflict
    FROM agentdash_ms_candidates c
    WHERE EXISTS (
        SELECT 1 FROM account a
        WHERE a.provider_id = 'microsoft' AND a.account_id = c.oid AND a.id <> c.id
      )
      OR (SELECT count(*) FROM agentdash_ms_candidates o WHERE o.oid = c.oid) > 1;

    UPDATE account a
    SET account_id = c.oid, updated_at = now()
    FROM agentdash_ms_candidates c
    WHERE a.id = c.id
      AND a.provider_id = 'microsoft'
      AND NOT (c.id = ANY (v_conflict));
    GET DIAGNOSTICS v_rekeyed = ROW_COUNT;

    RAISE NOTICE 'agentdash: migration 0153 re-keyed % of % Microsoft sign-in accounts from sub to oid (% already keyed by oid, % left unchanged)',
      v_rekeyed, v_total, v_already, cardinality(v_unresolved) + cardinality(v_conflict);
    IF cardinality(v_unresolved) > 0 THEN
      RAISE NOTICE 'agentdash: migration 0153 left these Microsoft accounts keyed by sub because their stored id token gives no oid for that sub; those users sign in by email, or re-key them from a Microsoft Entra export (doc/RELEASING.md): %',
        array_to_string(v_unresolved, ', ');
    END IF;
    IF cardinality(v_conflict) > 0 THEN
      RAISE NOTICE 'agentdash: migration 0153 left these Microsoft accounts keyed by sub because their oid is already, or would become, another account row''s key; merge or remove the duplicate row: %',
        array_to_string(v_conflict, ', ');
    END IF;
  END IF;

  SELECT string_agg(format('%s: %s', provider_id, ids), '; ' ORDER BY provider_id, ids)
  INTO v_duplicates
  FROM (
    SELECT provider_id, string_agg(id, ' / ' ORDER BY id) AS ids FROM account
    GROUP BY provider_id, account_id HAVING count(*) > 1
  ) d;
  IF v_duplicates IS NOT NULL THEN
    RAISE NOTICE 'agentdash: migration 0153 found sign-in account keys shared by more than one row; Better Auth 1.7 refuses sign-in for these until the duplicates are resolved: %',
      v_duplicates;
  END IF;
END $$;
