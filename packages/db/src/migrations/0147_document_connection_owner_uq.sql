-- AgentDash: one active Microsoft document connection per owner per company.
--
-- An agent reads its steward's documents through exactly one row, so two
-- active rows for the same owner are an ambiguity, not a richer setup. Refuse
-- to migrate while any exist rather than picking a survivor: which grant to
-- keep is the owner's decision, and silently revoking one would cut access an
-- operator may be relying on. Resolve by revoking the extra rows (set
-- revoked_at), then re-run the migration.
DO $$
DECLARE
  v_groups integer;
BEGIN
  SELECT count(*) INTO v_groups
  FROM (
    SELECT 1
    FROM "connections"
    WHERE "provider" = 'microsoft' AND "revoked_at" IS NULL
    GROUP BY "company_id", "owner_type", "owner_id"
    HAVING count(*) > 1
  ) AS dupes;
  IF v_groups > 0 THEN
    RAISE EXCEPTION 'connections: % owner(s) hold more than one active microsoft connection; revoke the extras before applying 0147_document_connection_owner_uq', v_groups
      USING ERRCODE = 'unique_violation';
  END IF;
END
$$;--> statement-breakpoint
CREATE UNIQUE INDEX "connections_microsoft_active_owner_uq" ON "connections" USING btree ("company_id","owner_type","owner_id") WHERE "connections"."provider" = 'microsoft' and "connections"."revoked_at" is null;
