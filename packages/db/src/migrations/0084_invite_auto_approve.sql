-- AgentDash: auto-approve-invites — when a company_join invite has
-- auto_approve = true and a human accepts it, membership is granted
-- immediately (join request created already-approved) instead of waiting
-- for admin approval. Defaults to false so existing invites are unchanged.
-- IF NOT EXISTS: this instance's DB may already carry a vestigial auto_approve
-- column from a since-removed branch; keep the migration idempotent so it is a
-- no-op there and still creates the column on a fresh DB.
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "auto_approve" boolean DEFAULT false NOT NULL;
