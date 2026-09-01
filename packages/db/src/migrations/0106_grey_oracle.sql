CREATE TABLE "bridge_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enrolled_at" timestamp with time zone,
	"approved_by_user_id" text,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bridge_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"requested_by_agent_id" uuid,
	"task_class" text NOT NULL,
	"instruction" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"approval_id" uuid,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"requeue_count" text DEFAULT '0' NOT NULL,
	"result_token_hash" text,
	"result" text,
	"outcome" text,
	"decline_reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bridge_endpoints" ADD CONSTRAINT "bridge_endpoints_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_tasks" ADD CONSTRAINT "bridge_tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_tasks" ADD CONSTRAINT "bridge_tasks_endpoint_id_bridge_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."bridge_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_tasks" ADD CONSTRAINT "bridge_tasks_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_tasks" ADD CONSTRAINT "bridge_tasks_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bridge_endpoints_token_hash_uq" ON "bridge_endpoints" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "bridge_endpoints_active_label_uq" ON "bridge_endpoints" USING btree ("company_id","user_id","label") WHERE "bridge_endpoints"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "bridge_endpoints_company_idx" ON "bridge_endpoints" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "bridge_tasks_poll_idx" ON "bridge_tasks" USING btree ("endpoint_id","status","created_at");--> statement-breakpoint
CREATE INDEX "bridge_tasks_company_idx" ON "bridge_tasks" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "bridge_tasks_approval_idx" ON "bridge_tasks" USING btree ("approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bridge_tasks_result_token_uq" ON "bridge_tasks" USING btree ("result_token_hash") WHERE "bridge_tasks"."result_token_hash" is not null;