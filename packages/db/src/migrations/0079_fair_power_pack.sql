CREATE TABLE "deep_interview_specs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_id" uuid NOT NULL,
	"goal" text NOT NULL,
	"constraints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"non_goals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ontology" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"final_ambiguity" real NOT NULL,
	"dimension_scores" jsonb NOT NULL,
	"crystallized_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deep_interview_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"scope_ref_id" uuid NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"current_round" integer DEFAULT 0 NOT NULL,
	"ambiguity_score" real,
	"dimension_scores" jsonb,
	"ontology_snapshots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"challenge_modes_used" text[] DEFAULT '{}'::text[] NOT NULL,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cos_onboarding_states" ADD COLUMN "deep_interview_spec_id" uuid;--> statement-breakpoint
ALTER TABLE "deep_interview_specs" ADD CONSTRAINT "deep_interview_specs_state_id_deep_interview_states_id_fk" FOREIGN KEY ("state_id") REFERENCES "public"."deep_interview_states"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deep_interview_states_scope_idx" ON "deep_interview_states" USING btree ("scope","scope_ref_id");--> statement-breakpoint
CREATE INDEX "deep_interview_states_status_idx" ON "deep_interview_states" USING btree ("status");--> statement-breakpoint
ALTER TABLE "cos_onboarding_states" ADD CONSTRAINT "cos_onboarding_states_deep_interview_spec_id_deep_interview_specs_id_fk" FOREIGN KEY ("deep_interview_spec_id") REFERENCES "public"."deep_interview_specs"("id") ON DELETE set null ON UPDATE no action;