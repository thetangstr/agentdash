-- Autonomy, decided 2026-08-19: an agent either mirrors one person or works on
-- its own, and the board says which.
--
-- Until now "no active stewardship" carried two meanings that need opposite
-- handling: an agent whose pairing was never set up (someone should finish it)
-- and an agent that is meant to run without a person (nobody should). Both read
-- as unstewarded, so approval cards for either were delivered to nobody and no
-- screen could tell a human which case they were looking at.
--
ALTER TABLE "agents" ADD COLUMN "autonomy" text DEFAULT 'stewarded' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "accountable_user_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_autonomy_ck" CHECK ("agents"."autonomy" in ('stewarded', 'autonomous'));--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_accountable_ck" CHECK ("agents"."autonomy" <> 'autonomous' or "agents"."accountable_user_id" is not null);
--> statement-breakpoint
-- Backfill. Anything already paired with a human stays `stewarded`, which is the
-- column default, so those rows are deliberately not touched.
--
-- An unpaired agent becomes `autonomous` and is made accountable to its creator
-- — the closest thing to an answer the existing data has — falling back to the
-- company's first administrator for agents hired by another agent, which is the
-- same fallback the `created_by_user_id` backfill used.
--
-- An unpaired agent with no creator AND no administrator to fall back to is
-- left `stewarded` and unpaired on purpose. That is the honest reading (the
-- pairing was never finished) and it keeps `agents_accountable_ck` satisfiable;
-- inventing an accountable human where the data has none is the failure mode
-- this whole change exists to remove. Those rows show as "pairing not set up".
--
-- Terminated agents are included: they carry history someone may still have to
-- answer questions about, and leaving them in the ambiguous state would mean
-- the board still cannot explain what it is showing.
UPDATE "agents" a
SET "autonomy" = 'autonomous',
    "accountable_user_id" = COALESCE(
      a."created_by_user_id",
      (
        SELECT m."principal_id"
        FROM "company_memberships" m
        WHERE m."company_id" = a."company_id"
          AND m."principal_type" = 'user'
          AND m."status" = 'active'
          AND m."membership_role" = 'admin'
        ORDER BY m."created_at" ASC
        LIMIT 1
      )
    ),
    "updated_at" = now()
WHERE NOT EXISTS (
    SELECT 1
    FROM "agent_stewardships" s
    WHERE s."agent_id" = a."id"
      AND s."company_id" = a."company_id"
      AND s."ended_at" IS NULL
  )
  AND COALESCE(
    a."created_by_user_id",
    (
      SELECT m."principal_id"
      FROM "company_memberships" m
      WHERE m."company_id" = a."company_id"
        AND m."principal_type" = 'user'
        AND m."status" = 'active'
        AND m."membership_role" = 'admin'
      ORDER BY m."created_at" ASC
      LIMIT 1
    )
  ) IS NOT NULL;
