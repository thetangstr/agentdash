-- AgentDash (Test Drive, Slice 3): shareable, read-only trial artifacts.
-- Adds an opaque url-safe share_token to trial_artifacts so a trial user can
-- share a single artifact via a PUBLIC link. Null until shared; unique (partial,
-- ignoring NULLs) so a token resolves to exactly one artifact.
-- See docs/superpowers/specs/2026-06-27-test-drive-no-signup-trial.md (§6).

ALTER TABLE "trial_artifacts" ADD COLUMN "share_token" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "trial_artifacts_share_token_unique_idx" ON "trial_artifacts" USING btree ("share_token") WHERE "share_token" IS NOT NULL;
