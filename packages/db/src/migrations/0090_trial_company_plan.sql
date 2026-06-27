-- AgentDash (Test Drive): autonomous-company plan storage.
-- The multi-agent trial shows an entire company assembling from one intake: a
-- Chief of Staff designs a tailored team of 3-4 agents, the team is provisioned,
-- and each agent runs its first task. We persist the designed plan (company name,
-- mission, and the agent roster with their provisioned ids + charters + first
-- tasks) on the trial session so the fleet view can render it. JSONB, nullable
-- until the user designs a company.
-- See docs/superpowers/specs/2026-06-27-test-drive-no-signup-trial.md.

ALTER TABLE "trial_sessions" ADD COLUMN "company_plan" jsonb;
