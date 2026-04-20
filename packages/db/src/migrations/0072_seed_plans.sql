-- Seed the three entitlement tiers referenced by company_plan.plan_id FK.
-- Without these rows, entitlementsService.setTier() fails with a FK violation.
INSERT INTO "plans" ("id", "display_name", "monthly_price_cents")
VALUES
  ('free', 'Free', 0),
  ('pro', 'Pro', 9900),
  ('enterprise', 'Enterprise', 49900)
ON CONFLICT ("id") DO NOTHING;
