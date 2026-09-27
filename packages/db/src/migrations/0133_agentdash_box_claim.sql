-- AgentDash (#767): the persisted, atomically-taken claim of a hosted box (one row at most).
CREATE TABLE "agentdash_box_claim" (
	"id" text PRIMARY KEY DEFAULT 'box' NOT NULL,
	"email" text NOT NULL,
	"attempt" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
