UPDATE "issues"
SET "definition_of_done" = jsonb_build_object(
  'summary',
  coalesce(nullif("title", ''), 'Definition of done'),
  'criteria',
  (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id',
        'c' || criterion.ordinality::text,
        'text',
        btrim(criterion.value),
        'done',
        false
      )
      ORDER BY criterion.ordinality
    )
    FROM jsonb_array_elements_text("issues"."definition_of_done") WITH ORDINALITY AS criterion(value, ordinality)
    WHERE btrim(criterion.value) <> ''
  )
)
WHERE "definition_of_done" IS NOT NULL
  AND jsonb_typeof("definition_of_done") = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text("issues"."definition_of_done") AS criterion(value)
    WHERE btrim(criterion.value) <> ''
  );--> statement-breakpoint

UPDATE "projects"
SET "definition_of_done" = jsonb_build_object(
  'summary',
  coalesce(nullif("name", ''), 'Definition of done'),
  'criteria',
  (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id',
        'c' || criterion.ordinality::text,
        'text',
        btrim(criterion.value),
        'done',
        false
      )
      ORDER BY criterion.ordinality
    )
    FROM jsonb_array_elements_text("projects"."definition_of_done") WITH ORDINALITY AS criterion(value, ordinality)
    WHERE btrim(criterion.value) <> ''
  )
)
WHERE "definition_of_done" IS NOT NULL
  AND jsonb_typeof("definition_of_done") = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text("projects"."definition_of_done") AS criterion(value)
    WHERE btrim(criterion.value) <> ''
  );
