-- AgentDash (consolidation PR-C): server-set authorship for activity rows.
-- Nullable with NO default: rows written before this migration, and any
-- future insert that forgets to say, read as origin unknown (NULL), never as
-- a server record. Every server insert site sets 'server' explicitly; the
-- manual activity POST writes 'manual'.
ALTER TABLE "activity_log" ADD COLUMN "origin" text;
