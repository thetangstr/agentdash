-- Migration 0068: Sync pipeline_runs schema with Drizzle model
-- Adds missing columns (input_data, output_data) and drops dead column (current_stage)

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pipeline_runs' AND column_name = 'input_data'
  ) THEN
    ALTER TABLE "pipeline_runs" ADD COLUMN "input_data" jsonb;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pipeline_runs' AND column_name = 'output_data'
  ) THEN
    ALTER TABLE "pipeline_runs" ADD COLUMN "output_data" jsonb;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pipeline_runs' AND column_name = 'current_stage'
  ) THEN
    ALTER TABLE "pipeline_runs" DROP COLUMN "current_stage";
  END IF;
END $$;
