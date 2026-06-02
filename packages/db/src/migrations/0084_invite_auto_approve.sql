-- AgentDash: auto-approve-invites — when a company_join invite has
-- auto_approve = true and a human accepts it, membership is granted
-- immediately (join request created already-approved) instead of waiting
-- for admin approval. Defaults to false so existing invites are unchanged.
ALTER TABLE "invites" ADD COLUMN "auto_approve" boolean DEFAULT false NOT NULL;
