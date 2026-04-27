-- AgentDash (AGE-55): FRE Plan B — invite-only signup with domain-keyed
-- companies. Adds the nullable companies.email_domain column, backfills
-- existing rows from each company's first board/owner membership, and
-- enforces one company per non-NULL domain via a partial unique index.

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "email_domain" text;
--> statement-breakpoint

-- Backfill: derive email_domain from the first board/owner board user
-- membership we can find for each company. Free-mail rule: if the domain is
-- in the blocklist, store the full email; otherwise store the bare domain.
-- Companies without any matching membership are left NULL and surfaced via
-- the RAISE NOTICE at the end so they are visible in migration logs.
DO $$
DECLARE
  free_mail_domains text[] := ARRAY[
    'gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com',
    'yahoo.com','ymail.com','icloud.com','me.com','mac.com','proton.me','protonmail.com',
    'pm.me','aol.com','gmx.com','mail.com','zoho.com','fastmail.com','hey.com','duck.com'
  ];
  rec RECORD;
  raw_email text;
  trimmed text;
  at_idx int;
  local_part text;
  domain_part text;
  plus_idx int;
  derived text;
BEGIN
  FOR rec IN
    SELECT c.id AS company_id, u.email AS user_email
    FROM companies c
    LEFT JOIN LATERAL (
      SELECT m.principal_id, m.created_at
      FROM company_memberships m
      WHERE m.company_id = c.id
        AND m.principal_type = 'user'
        AND m.status = 'active'
        AND (m.membership_role IN ('owner','board') OR m.membership_role IS NULL)
      ORDER BY
        -- Prefer explicit board/owner rows over NULL-role memberships.
        CASE WHEN m.membership_role IN ('owner','board') THEN 0 ELSE 1 END,
        m.created_at ASC
      LIMIT 1
    ) first_member ON TRUE
    LEFT JOIN "user" u ON u.id = first_member.principal_id
    WHERE c.email_domain IS NULL
  LOOP
    raw_email := rec.user_email;
    IF raw_email IS NULL OR length(trim(raw_email)) = 0 THEN
      RAISE NOTICE 'AGE-55 backfill: company % has no eligible board member; leaving email_domain NULL', rec.company_id;
      CONTINUE;
    END IF;

    trimmed := lower(trim(raw_email));
    at_idx := position('@' IN trimmed);
    IF at_idx <= 1 OR at_idx = length(trimmed) THEN
      RAISE NOTICE 'AGE-55 backfill: company % has unparseable creator email %; leaving email_domain NULL', rec.company_id, raw_email;
      CONTINUE;
    END IF;
    local_part := substring(trimmed FROM 1 FOR at_idx - 1);
    domain_part := substring(trimmed FROM at_idx + 1);
    IF position('.' IN domain_part) = 0 THEN
      RAISE NOTICE 'AGE-55 backfill: company % has email with no TLD %; leaving email_domain NULL', rec.company_id, raw_email;
      CONTINUE;
    END IF;
    plus_idx := position('+' IN local_part);
    IF plus_idx > 0 THEN
      local_part := substring(local_part FROM 1 FOR plus_idx - 1);
    END IF;

    IF domain_part = ANY(free_mail_domains) THEN
      derived := local_part || '@' || domain_part;
    ELSE
      derived := domain_part;
    END IF;

    -- Avoid colliding with another grandfathered company that already grabbed
    -- the same domain — leave NULL and log it. Operators can dedupe later.
    IF EXISTS (SELECT 1 FROM companies WHERE email_domain = derived) THEN
      RAISE NOTICE 'AGE-55 backfill: company % shares derived domain % with an existing row; leaving email_domain NULL (grandfathered duplicate)', rec.company_id, derived;
      CONTINUE;
    END IF;

    UPDATE companies SET email_domain = derived WHERE id = rec.company_id;
  END LOOP;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "companies_email_domain_unique_idx"
  ON "companies" ("email_domain")
  WHERE "email_domain" IS NOT NULL;
