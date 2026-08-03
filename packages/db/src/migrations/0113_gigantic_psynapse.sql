CREATE TABLE "deliverable_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"deliverable_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb NOT NULL,
	"severity" text DEFAULT 'blocking' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliverable_checks_kind_ck" CHECK ("deliverable_checks"."kind" in ('moved_more_than', 'missing', 'matches_prior', 'range', 'custom')),
	CONSTRAINT "deliverable_checks_severity_ck" CHECK ("deliverable_checks"."severity" in ('blocking', 'advisory'))
);
--> statement-breakpoint
CREATE TABLE "deliverable_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"deliverable_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"source_type" text NOT NULL,
	"derivation" text NOT NULL,
	"owner_agent_id" uuid NOT NULL,
	"connector_provider" text,
	"connector_config" jsonb,
	"order_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliverable_facts_source_type_ck" CHECK ("deliverable_facts"."source_type" in ('system', 'human')),
	CONSTRAINT "deliverable_facts_source_shape_ck" CHECK (("deliverable_facts"."source_type" = 'system') = ("deliverable_facts"."connector_provider" is not null and "deliverable_facts"."connector_config" is not null))
);
--> statement-breakpoint
CREATE TABLE "deliverable_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"deliverable_id" uuid NOT NULL,
	"run_key" text NOT NULL,
	"status" text DEFAULT 'collecting' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assembled_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"check_passed" boolean,
	"check_outcome" jsonb,
	"check_draft_hash" text,
	"first_approval_id" uuid,
	"first_approved_at" timestamp with time zone,
	"second_approval_id" uuid,
	"second_approved_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone,
	"abandon_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliverable_runs_status_ck" CHECK ("deliverable_runs"."status" in ('collecting', 'assembled', 'checked', 'awaiting_approval', 'approved', 'shipped', 'abandoned')),
	CONSTRAINT "deliverable_runs_checked_has_verdict_ck" CHECK ("deliverable_runs"."status" not in ('checked', 'awaiting_approval', 'approved', 'shipped')
          or ("deliverable_runs"."checked_at" is not null and "deliverable_runs"."check_outcome" is not null and "deliverable_runs"."check_draft_hash" is not null)),
	CONSTRAINT "deliverable_runs_sequential_approval_ck" CHECK ("deliverable_runs"."second_approval_id" is null or "deliverable_runs"."first_approved_at" is not null),
	CONSTRAINT "deliverable_runs_both_approvals_to_ship_ck" CHECK ("deliverable_runs"."status" not in ('approved', 'shipped')
          or ("deliverable_runs"."first_approval_id" is not null and "deliverable_runs"."first_approved_at" is not null
              and "deliverable_runs"."second_approval_id" is not null and "deliverable_runs"."second_approved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "deliverables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"cadence" text NOT NULL,
	"assembler_agent_id" uuid NOT NULL,
	"first_approver_user_id" text NOT NULL,
	"second_approver_user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliverables_cadence_ck" CHECK ("deliverables"."cadence" in ('weekly', 'monthly')),
	CONSTRAINT "deliverables_status_ck" CHECK ("deliverables"."status" in ('active', 'paused')),
	CONSTRAINT "deliverables_distinct_approvers_ck" CHECK ("deliverables"."first_approver_user_id" <> "deliverables"."second_approver_user_id")
);
--> statement-breakpoint
CREATE TABLE "fact_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"fact_id" uuid NOT NULL,
	"correction" jsonb NOT NULL,
	"reason" text NOT NULL,
	"origin_run_id" uuid,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "fact_corrections_kind_ck" CHECK ("fact_corrections"."correction" ->> 'kind' in ('replace_source', 'annotate', 'override_value'))
);
--> statement-breakpoint
CREATE TABLE "fact_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"fact_id" uuid NOT NULL,
	"value" jsonb,
	"status" text NOT NULL,
	"source_ref" text,
	"method" text,
	"fetched_at" timestamp with time zone,
	"flagged" boolean DEFAULT false NOT NULL,
	"flag_reason" text,
	"answered_by_agent_id" uuid,
	"answered_at" timestamp with time zone,
	"applied_correction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fact_values_status_ck" CHECK ("fact_values"."status" in ('fetched', 'asked', 'answered', 'missing')),
	CONSTRAINT "fact_values_provenance_ck" CHECK ("fact_values"."status" not in ('fetched', 'answered')
          or ("fact_values"."source_ref" is not null and "fact_values"."method" is not null and "fact_values"."fetched_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "deliverable_checks" ADD CONSTRAINT "deliverable_checks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_checks" ADD CONSTRAINT "deliverable_checks_deliverable_id_deliverables_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."deliverables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_facts" ADD CONSTRAINT "deliverable_facts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_facts" ADD CONSTRAINT "deliverable_facts_deliverable_id_deliverables_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."deliverables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_facts" ADD CONSTRAINT "deliverable_facts_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_runs" ADD CONSTRAINT "deliverable_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_runs" ADD CONSTRAINT "deliverable_runs_deliverable_id_deliverables_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."deliverables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_runs" ADD CONSTRAINT "deliverable_runs_first_approval_id_approvals_id_fk" FOREIGN KEY ("first_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_runs" ADD CONSTRAINT "deliverable_runs_second_approval_id_approvals_id_fk" FOREIGN KEY ("second_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_assembler_agent_id_agents_id_fk" FOREIGN KEY ("assembler_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_corrections" ADD CONSTRAINT "fact_corrections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_corrections" ADD CONSTRAINT "fact_corrections_fact_id_deliverable_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."deliverable_facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_corrections" ADD CONSTRAINT "fact_corrections_origin_run_id_deliverable_runs_id_fk" FOREIGN KEY ("origin_run_id") REFERENCES "public"."deliverable_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_values" ADD CONSTRAINT "fact_values_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_values" ADD CONSTRAINT "fact_values_run_id_deliverable_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."deliverable_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_values" ADD CONSTRAINT "fact_values_fact_id_deliverable_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."deliverable_facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_values" ADD CONSTRAINT "fact_values_answered_by_agent_id_agents_id_fk" FOREIGN KEY ("answered_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_values" ADD CONSTRAINT "fact_values_applied_correction_id_fact_corrections_id_fk" FOREIGN KEY ("applied_correction_id") REFERENCES "public"."fact_corrections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deliverable_checks_deliverable_key_uq" ON "deliverable_checks" USING btree ("deliverable_id","key");--> statement-breakpoint
CREATE INDEX "deliverable_checks_company_idx" ON "deliverable_checks" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deliverable_facts_deliverable_key_uq" ON "deliverable_facts" USING btree ("deliverable_id","key");--> statement-breakpoint
CREATE INDEX "deliverable_facts_order_idx" ON "deliverable_facts" USING btree ("deliverable_id","order_index");--> statement-breakpoint
CREATE INDEX "deliverable_facts_company_idx" ON "deliverable_facts" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deliverable_runs_run_key_uq" ON "deliverable_runs" USING btree ("deliverable_id","run_key");--> statement-breakpoint
CREATE INDEX "deliverable_runs_company_status_idx" ON "deliverable_runs" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "deliverables_company_key_uq" ON "deliverables" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "deliverables_company_idx" ON "deliverables" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fact_corrections_active_fact_uq" ON "fact_corrections" USING btree ("fact_id") WHERE "fact_corrections"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "fact_corrections_company_idx" ON "fact_corrections" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fact_values_run_fact_uq" ON "fact_values" USING btree ("run_id","fact_id");--> statement-breakpoint
CREATE INDEX "fact_values_company_idx" ON "fact_values" USING btree ("company_id");