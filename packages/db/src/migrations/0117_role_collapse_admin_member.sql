-- Role collapse, decided 2026-08-16: exactly two human roles.
-- owner -> admin; operator/viewer/anything else -> member.
--
-- Scoped strictly to principal_type = 'user': agent memberships already use
-- the string 'member' in this same column for their own purposes and must
-- not be rewritten. Measured before writing this: mkboard had 1 user row
-- (owner) and 3 agent rows ('member'); uat 1 and 1.
--
-- Invite payloads (defaults_payload.human.role) are deliberately NOT
-- rewritten here: every read passes through normalizeHumanRole, which maps
-- legacy strings, and editing jsonb in a migration risks more than it fixes.
UPDATE company_memberships
SET membership_role = CASE
      WHEN membership_role IN ('owner', 'admin') THEN 'admin'
      ELSE 'member'
    END,
    updated_at = now()
WHERE principal_type = 'user'
  AND membership_role IS NOT NULL
  AND membership_role NOT IN ('admin', 'member');
