-- AgentDash: rename the top-of-hierarchy role value from "ceo" to "chief_of_staff".
-- The Chief of Staff framing is role-agnostic and is the conductor of the goal-driven workflow.
UPDATE "agents" SET "role" = 'chief_of_staff' WHERE "role" = 'ceo';
--> statement-breakpoint
UPDATE "agent_templates" SET "role" = 'chief_of_staff' WHERE "role" = 'ceo';
