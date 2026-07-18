-- AgentDash (AGE-121): add is_overage flag to agent_runs.
-- True when the run executed beyond the workspace's included monthly
-- allotment (Pro overage tracking). Free workspaces are hard-blocked
-- before execution, so this flag is only relevant for Pro workspaces.

ALTER TABLE "agent_runs" ADD COLUMN "is_overage" boolean DEFAULT false NOT NULL;
