-- AgentDash: an agent's memory, and the corrections ("What changed") it is
-- built from, are readable only by the agent itself, its steward and admins.
-- Runs recorded before that kept copies of both where any company member
-- could read them:
--
--   heartbeat_runs.context_snapshot: paperclipAgentMemory,
--     paperclipAgentCorrections(Remaining), paperclipWake.corrections(Remaining);
--   heartbeat_run_events (adapter.invoke) payload: the same keys under
--     `context`, the rendered `## Your Memory` and
--     `## What changed (corrections to your work)` sections in `prompt`, and
--     the wake payload JSON in env.PAPERCLIP_WAKE_PAYLOAD_JSON.
--
-- The server stops writing them (server/src/services/run-private-content.ts);
-- this removes the old copies once.
--
-- Kept cheap. Only runs created since memory existed (2026-08-20) whose saved
-- context actually holds memory or a non-empty correction list are touched
-- (every wake payload carries `corrections: []`, which holds nothing); their
-- events are found through the run_id index, adapter.invoke only. Run logs
-- and output excerpts are not rewritten here: they are withheld when read
-- (server/src/services/run-log-private-content.ts).
--
-- Each section is replaced as a whole, heading included, and only inside
-- that section: memory from its heading through its content, corrections
-- from their heading through the last of their lines. A section that cannot
-- be matched exactly (a truncated stored prompt) is withheld from its heading
-- to the end. Safe to re-run: a cleaned row no longer matches.
CREATE FUNCTION pg_temp.agentdash_lessons_affected(ctx jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(ctx) = 'object' AND (
    ctx ? 'paperclipAgentMemory'
    OR CASE WHEN jsonb_typeof(ctx -> 'paperclipAgentCorrections') = 'array'
      THEN jsonb_array_length(ctx -> 'paperclipAgentCorrections') > 0 ELSE false END
    OR CASE WHEN jsonb_typeof(ctx #> '{paperclipWake,corrections}') = 'array'
      THEN jsonb_array_length(ctx #> '{paperclipWake,corrections}') > 0 ELSE false END
    OR CASE WHEN jsonb_typeof(ctx #> '{paperclipWake,correctionsRemaining}') = 'number'
      THEN (ctx #>> '{paperclipWake,correctionsRemaining}')::numeric > 0 ELSE false END
  )
$$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.agentdash_withhold_lessons_text(body text, ctx jsonb) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  out_text text := body;
  memory_marker constant text := '[agent memory withheld: readable only by the agent, its steward and admins]';
  corrections_marker constant text := '[corrections withheld: readable only by the agent, its steward and admins]';
  memory_content text;
  heading text;
  section_start int;
  section text;
  found_at int;
  section_end int;
  item jsonb;
  lesson jsonb;
  piece text;
  pieces text[] := '{}';
  all_found boolean := true;
  more_line text;
BEGIN
  IF out_text IS NULL THEN
    RETURN NULL;
  END IF;

  -- Memory: from its heading through its content.
  heading := (regexp_match(out_text, E'(?:^|\\n)(## Your Memory[^\\n]*\\n\\nThis is what you chose to remember)'))[1];
  IF heading IS NOT NULL THEN
    section_start := strpos(out_text, heading);
    section := substr(out_text, section_start);
    memory_content := regexp_replace(coalesce(ctx #>> '{paperclipAgentMemory,content}', ''), E'^\\s+|\\s+$', '', 'g');
    found_at := CASE WHEN memory_content <> '' THEN strpos(section, memory_content) ELSE 0 END;
    IF found_at > 0 THEN
      out_text := left(out_text, section_start - 1) || memory_marker
        || substr(section, found_at + length(memory_content));
    ELSE
      out_text := left(out_text, section_start - 1) || memory_marker;
    END IF;
  END IF;

  -- Corrections: from their heading through the last of their lines.
  heading := (regexp_match(out_text, E'(?:^|\\n)(## What changed \\(corrections to your work\\)\\n\\nA person or another agent changed)'))[1];
  IF heading IS NULL THEN
    RETURN out_text;
  END IF;
  section_start := strpos(out_text, heading);
  section := substr(out_text, section_start);

  FOR item IN
    SELECT value FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(ctx #> '{paperclipWake,corrections}') = 'array' THEN ctx #> '{paperclipWake,corrections}' ELSE '[]'::jsonb END
      || CASE WHEN jsonb_typeof(ctx -> 'paperclipAgentCorrections') = 'array' THEN ctx -> 'paperclipAgentCorrections' ELSE '[]'::jsonb END
    )
  LOOP
    IF coalesce(item ->> 'summary', '') <> '' THEN
      pieces := pieces || ('   ' || replace(item ->> 'summary', E'\n', E'\n   '));
    END IF;
    IF jsonb_typeof(item -> 'lessons') = 'array' THEN
      FOR lesson IN SELECT value FROM jsonb_array_elements(item -> 'lessons') LOOP
        IF jsonb_typeof(lesson) = 'string' AND (lesson #>> '{}') <> '' THEN
          pieces := pieces || ('   - ' || (lesson #>> '{}'));
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  section_end := 0;
  IF cardinality(pieces) = 0 THEN
    all_found := false;
  END IF;
  FOREACH piece IN ARRAY pieces LOOP
    found_at := strpos(section, piece);
    IF found_at = 0 THEN
      -- Hermes renders the section template-escaped.
      piece := replace(piece, '{{', '{ {');
      found_at := strpos(section, piece);
    END IF;
    IF found_at = 0 THEN
      all_found := false;
      EXIT;
    END IF;
    section_end := greatest(section_end, found_at + length(piece) - 1);
  END LOOP;

  IF NOT all_found THEN
    RETURN left(out_text, section_start - 1) || corrections_marker;
  END IF;
  more_line := substring(substr(section, section_end + 1) from E'^\\n\\n\\d+ more corrections? (?:is|are) waiting and will come with your next run\\.');
  IF more_line IS NOT NULL THEN
    section_end := section_end + length(more_line);
  END IF;
  RETURN left(out_text, section_start - 1) || corrections_marker || substr(section, section_end + 1);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.agentdash_withhold_lessons_context(ctx jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(ctx) <> 'object' THEN ctx
    ELSE (ctx - 'paperclipAgentMemory' - 'paperclipAgentCorrections' - 'paperclipAgentCorrectionsRemaining')
      #- '{paperclipWake,corrections}' #- '{paperclipWake,correctionsRemaining}'
  END
$$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.agentdash_withhold_lessons_wake_json(value text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  IF value IS NULL OR strpos(value, '"corrections"') = 0 THEN
    RETURN value;
  END IF;
  BEGIN
    RETURN ((value::jsonb) - 'corrections' - 'correctionsRemaining')::text;
  EXCEPTION WHEN others THEN
    -- This key only ever holds the wake payload; a copy that no longer
    -- parses (cut short) still holds its corrections.
    IF strpos(value, '"corrections":[{') > 0 THEN
      RETURN '[corrections withheld: readable only by the agent, its steward and admins]';
    END IF;
    RETURN value;
  END;
END;
$$;
--> statement-breakpoint
UPDATE "heartbeat_run_events" e
SET "payload" = (
  WITH stripped AS (
    SELECT CASE
      WHEN jsonb_typeof(e."payload" -> 'context') = 'object'
        THEN jsonb_set(e."payload", '{context}', pg_temp.agentdash_withhold_lessons_context(e."payload" -> 'context'))
      ELSE e."payload"
    END AS p
  ),
  prompted AS (
    SELECT CASE
      WHEN jsonb_typeof(p -> 'prompt') = 'string'
        THEN jsonb_set(p, '{prompt}', to_jsonb(pg_temp.agentdash_withhold_lessons_text(p ->> 'prompt', coalesce(e."payload" -> 'context', '{}'::jsonb))))
      ELSE p
    END AS p
    FROM stripped
  )
  SELECT CASE
    WHEN jsonb_typeof(p #> '{env,PAPERCLIP_WAKE_PAYLOAD_JSON}') = 'string'
      THEN jsonb_set(p, '{env,PAPERCLIP_WAKE_PAYLOAD_JSON}', to_jsonb(pg_temp.agentdash_withhold_lessons_wake_json(p #>> '{env,PAPERCLIP_WAKE_PAYLOAD_JSON}')))
    ELSE p
  END
  FROM prompted
)
FROM "heartbeat_runs" r
WHERE r."created_at" >= '2026-08-20'
  AND pg_temp.agentdash_lessons_affected(r."context_snapshot")
  AND e."run_id" = r."id"
  AND e."event_type" = 'adapter.invoke'
  AND jsonb_typeof(e."payload") = 'object';
--> statement-breakpoint
UPDATE "heartbeat_runs"
SET "context_snapshot" = pg_temp.agentdash_withhold_lessons_context("context_snapshot")
WHERE "created_at" >= '2026-08-20'
  AND pg_temp.agentdash_lessons_affected("context_snapshot");
--> statement-breakpoint
DROP FUNCTION pg_temp.agentdash_withhold_lessons_text(text, jsonb);
--> statement-breakpoint
DROP FUNCTION pg_temp.agentdash_withhold_lessons_context(jsonb);
--> statement-breakpoint
DROP FUNCTION pg_temp.agentdash_withhold_lessons_wake_json(text);
--> statement-breakpoint
DROP FUNCTION pg_temp.agentdash_lessons_affected(jsonb);
