-- AgentDash: an agent's memory, and the corrections ("What changed") it is
-- built from, are readable only by the agent itself, its steward and admins.
-- Runs recorded before that kept copies of both where any company member
-- could read them:
--
--   heartbeat_runs.context_snapshot: paperclipAgentMemory,
--     paperclipAgentCorrections, paperclipAgentCorrectionsRemaining, and
--     paperclipWake.corrections / paperclipWake.correctionsRemaining;
--   heartbeat_run_events (adapter.invoke) payload: the same keys under
--     `context`, the rendered `## Your Memory` and
--     `## What changed (corrections to your work)` sections in `prompt`, and
--     the wake payload JSON in env.PAPERCLIP_WAKE_PAYLOAD_JSON.
--
-- The server stops writing them (server/src/services/run-private-content.ts);
-- this removes the old copies once. Bounded: only rows that still carry a
-- private key, and only adapter.invoke events. Safe to re-run: a cleaned row
-- is left as it is. Memory is replaced exactly by its content; corrections by
-- their rendered summary and lesson lines. A section that cannot be found
-- exactly (a truncated stored prompt) is withheld from its heading to the end.
CREATE FUNCTION pg_temp.agentdash_withhold_lessons_text(body text, ctx jsonb) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  out_text text := body;
  memory_marker constant text := '[agent memory withheld: readable only by the agent, its steward and admins]';
  corrections_marker constant text := '[corrections withheld: readable only by the agent, its steward and admins]';
  memory_content text;
  heading text;
  item jsonb;
  lesson jsonb;
  piece text;
  pieces text[];
  done text[] := '{}';
  all_found boolean := true;
  any_items boolean := false;
BEGIN
  IF out_text IS NULL THEN
    RETURN NULL;
  END IF;

  memory_content := regexp_replace(coalesce(ctx #>> '{paperclipAgentMemory,content}', ''), E'^\\s+|\\s+$', '', 'g');
  IF memory_content <> '' AND strpos(out_text, memory_content) > 0 THEN
    out_text := replace(out_text, memory_content, memory_marker);
  ELSIF strpos(out_text, memory_marker) = 0 THEN
    heading := (regexp_match(out_text, E'(?:^|\\n)(## Your Memory[^\\n]*\\n\\nThis is what you chose to remember)'))[1];
    IF heading IS NOT NULL THEN
      out_text := left(out_text, strpos(out_text, heading) - 1) || memory_marker;
    END IF;
  END IF;

  FOR item IN
    SELECT value FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(ctx #> '{paperclipWake,corrections}') = 'array' THEN ctx #> '{paperclipWake,corrections}' ELSE '[]'::jsonb END
      || CASE WHEN jsonb_typeof(ctx -> 'paperclipAgentCorrections') = 'array' THEN ctx -> 'paperclipAgentCorrections' ELSE '[]'::jsonb END
    )
  LOOP
    any_items := true;
    pieces := '{}';
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
    -- Each rendered line is replaced where it appears, as rendered or
    -- Hermes-escaped. The same item can be listed twice (the wake payload
    -- and the context key); a line handled once counts as found.
    FOREACH piece IN ARRAY pieces LOOP
      IF piece = ANY(done) THEN
        CONTINUE;
      ELSIF strpos(out_text, piece) > 0 THEN
        out_text := replace(out_text, piece, CASE WHEN left(piece, 5) = '   - ' THEN '   - ' ELSE '   ' END || corrections_marker);
      ELSIF strpos(out_text, replace(piece, '{{', '{ {')) > 0 THEN
        out_text := replace(out_text, replace(piece, '{{', '{ {'), CASE WHEN left(piece, 5) = '   - ' THEN '   - ' ELSE '   ' END || corrections_marker);
      ELSE
        all_found := false;
      END IF;
      done := done || piece;
    END LOOP;
  END LOOP;

  -- The section, when this pass could not withhold every line of it (a
  -- truncated stored prompt), or when there is no context copy to match and
  -- it has not been withheld before.
  heading := (regexp_match(out_text, E'(?:^|\\n)(## What changed \\(corrections to your work\\)\\n\\nA person or another agent changed)'))[1];
  IF heading IS NOT NULL
    AND ((any_items AND NOT all_found) OR (NOT any_items AND strpos(out_text, corrections_marker) = 0)) THEN
    out_text := left(out_text, strpos(out_text, heading) - 1) || corrections_marker;
  END IF;

  RETURN out_text;
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
    RETURN '[corrections withheld: readable only by the agent, its steward and admins]';
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
WHERE e."event_type" = 'adapter.invoke'
  AND jsonb_typeof(e."payload") = 'object'
  AND (
    e."payload" -> 'context' ?| array['paperclipAgentMemory', 'paperclipAgentCorrections', 'paperclipAgentCorrectionsRemaining']
    OR e."payload" #> '{context,paperclipWake}' ?| array['corrections', 'correctionsRemaining']
    OR strpos(coalesce(e."payload" ->> 'prompt', ''), '## Your Memory') > 0
    OR strpos(coalesce(e."payload" ->> 'prompt', ''), '## What changed (corrections to your work)') > 0
    OR strpos(coalesce(e."payload" #>> '{env,PAPERCLIP_WAKE_PAYLOAD_JSON}', ''), '"corrections":[{') > 0
  );
--> statement-breakpoint
UPDATE "heartbeat_runs"
SET "context_snapshot" = pg_temp.agentdash_withhold_lessons_context("context_snapshot")
WHERE jsonb_typeof("context_snapshot") = 'object'
  AND (
    "context_snapshot" ?| array['paperclipAgentMemory', 'paperclipAgentCorrections', 'paperclipAgentCorrectionsRemaining']
    OR "context_snapshot" -> 'paperclipWake' ?| array['corrections', 'correctionsRemaining']
  );
--> statement-breakpoint
DROP FUNCTION pg_temp.agentdash_withhold_lessons_text(text, jsonb);
--> statement-breakpoint
DROP FUNCTION pg_temp.agentdash_withhold_lessons_context(jsonb);
--> statement-breakpoint
DROP FUNCTION pg_temp.agentdash_withhold_lessons_wake_json(text);
